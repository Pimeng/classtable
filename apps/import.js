import plugin from "../../../lib/plugins/plugin.js"
import fs from "node:fs"
import path from "node:path"
import { getJson, safeRecallEventMsg } from "../utils/appHelpers.js"
import config from "../utils/config.js"
import {
  convertNativeToInternal,
  convertShiguangToInternal,
  detectScheduleFormat
} from "../utils/scheduleFormat.js"
import { ensureScheduleDataDirs, saveUserScheduleData } from "../utils/scheduleStorage.js"
import { generateCourseScheduleFromWakeupData } from "../utils/importParser.js"

const MAX_IMPORT_FILE_SIZE = 2 * 1024 * 1024
const WAKEUP_SHARE_REG = /这是来自「WakeUp课程表」的课表分享，30分钟内有效哦，如果失效请朋友再分享一遍叭。为了保护隐私我们选择不监听你的剪贴板，请复制这条消息后，打开App的主界面，右上角第二个按钮 -> 从分享口令导入，按操作提示即可完成导入~分享口令为「(.*)」/
/** 不用先发「导入课表」也能自动导入的文件名：插件导出名、拾光默认导出名、以及名字里带课表/schedule 的 json */
const AUTO_IMPORT_FILE_REG = /(?:^classtable-|^shiguang|课表|schedule).*\.json$/i

ensureScheduleDataDirs()

/** 找到消息里的 file 段（核心只会把 name/fid 提到 e.file，其余字段要回原始段里取） */
function findFileSegment(e) {
  const segments = Array.isArray(e?.message) ? e.message : []
  return segments.find((segment) => segment && segment.type === "file") || null
}

/** 各适配器的文件段字段名不统一，逐个兜一遍 */
function resolveFileName(e, segment) {
  const raw = e?.file?.name
    || segment?.name
    || segment?.filename
    || segment?.file_name
    || segment?.data?.name
    || segment?.data?.filename
    || (typeof segment?.file === "string" && !/^https?:\/\//i.test(segment.file) ? segment.file : "")
    || ""
  return String(raw).split(/[\\/]/).pop()
}

/** 导入失败时把文件原样存一份，方便回头对字段（各版本课程表 App 的导出 schema 差异很大） */
const DEBUG_DUMP_DIR = path.join("./plugins", "classtable", "data", "debug")

function dumpFailedImport(fileName, fileContent) {
  if (typeof fileContent !== "string" || !fileContent) return
  try {
    fs.mkdirSync(DEBUG_DUMP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const safeName = String(fileName || "schedule.json").replace(/[^\w.-]/g, "_")
    const target = path.join(DEBUG_DUMP_DIR, `${stamp}-${safeName}`)
    fs.writeFileSync(target, fileContent, "utf8")
    logger.error(`[ClassTable] 导入失败的文件已留存: ${target}`)
  } catch (error) {
    logger.error(`[ClassTable] 留存失败文件时出错: ${error.message || error}`)
  }
}

/** 只描述结构，不打印课程内容，日志里足够定位字段名 */
function describeShape(rawData) {
  if (!rawData || typeof rawData !== "object") return typeof rawData
  const keys = Object.keys(rawData)
  const courses = rawData.courses
  const firstCourse = Array.isArray(courses) && courses[0] && typeof courses[0] === "object"
    ? Object.keys(courses[0])
    : null
  const parts = [`顶层=[${keys.join(",")}]`]
  if (Array.isArray(courses)) parts.push(`courses=${courses.length}条`)
  if (firstCourse) parts.push(`首条课程=[${firstCourse.join(",")}]`)
  if (Array.isArray(rawData.timeSlots)) {
    const first = rawData.timeSlots[0]
    parts.push(`timeSlots=${rawData.timeSlots.length}条${first && typeof first === "object" ? `=[${Object.keys(first).join(",")}]` : ""}`)
  }
  return parts.join(" ")
}

export class classtableImport extends plugin {
  constructor() {
    super({
      name: "classtable:导入课表",
      dsc: "支持 WakeUp 口令、插件标准 JSON、拾光 JSON 的课表导入",
      event: "message",
      priority: 10,
      rule: [
        {
          reg: "^#?(?:ct|课表|classtable)?导入课表$",
          fnc: "prepareJsonImport"
        },
        {
          reg: "^.*$",
          fnc: "receiveScheduleFile"
        },
        {
          reg: "^这是来自「WakeUp课程表」的课表分享",
          fnc: "importWakeUpSchedule"
        }
      ]
    })
  }

  async prepareJsonImport(e) {
    /**
     * 上下文 key 必须等于处理函数的函数名：loader 是按 `plugin[fnc](context[fnc])` 调的
     * （对照 genshin 的 setContext("saveUid") / saveUid()）。
     * 以前写成 "importScheduleFile" 而函数叫 receiveScheduleFile，
     * 于是待导入期间的下一条消息会直接 TypeError: plugin[fnc] is not a function，
     * 文件根本没机会被处理。
     */
    this.setContext("receiveScheduleFile", e.isGroup)
    await e.reply("请发送 JSON 课表文件，Bot会自动识别插件标准格式或拾光格式")
  }

  async receiveScheduleFile(e) {
    /**
     * 作为上下文回调被调用时，loader 传进来的 `e` 是当时 setContext 存下的「导入课表」那条旧事件，
     * 当前消息在 this.e（Yunzai 固定约定）；走正则规则进来时两者是同一个。
     */
    const ev = this.e || e
    const segment = findFileSegment(ev)
    const fileName = resolveFileName(ev, segment)
    if (!fileName) return false

    const waitingImport = this.getContext("receiveScheduleFile", ev.isGroup)
    const isAutoImportFile = AUTO_IMPORT_FILE_REG.test(fileName)
    if (!waitingImport && !isAutoImportFile) return false

    if (!/\.json$/i.test(fileName)) {
      if (waitingImport) {
        this.finish("receiveScheduleFile", ev.isGroup)
        await ev.reply("导入失败：请发送 `.json` 格式的课程表文件喵")
      }
      return false
    }

    if (waitingImport) {
      this.finish("receiveScheduleFile", ev.isGroup)
    }

    let fileContent = null
    let rawData = null
    try {
      fileContent = await this.downloadIncomingFile(ev)
      rawData = JSON.parse(fileContent)
      const format = detectScheduleFormat(rawData)

      if (!format) {
        await ev.reply("导入失败：暂时无法识别这个 JSON 课表格式。支持插件标准格式、拾光格式，以及旧版内部存档格式。")
        return true
      }

      let courseSchedule
      if (format === "native") {
        courseSchedule = convertNativeToInternal(rawData)
      } else if (format === "shiguang") {
        courseSchedule = convertShiguangToInternal(rawData)
      } else {
        courseSchedule = rawData
      }

      saveUserScheduleData(ev.user_id, ev.isGroup ? ev.group_id : null, courseSchedule)

      const importedFrom = format === "native"
        ? "插件标准格式"
        : format === "shiguang"
          ? "拾光格式"
          : "旧版内部格式"

      await ev.reply(`导入课程表成功，已识别为${importedFrom}。重复导入会覆盖之前的数据。`)
      if (ev.isGroup) {
        await ev.reply("已收到文件，如有需要请手动撤回", false, { at: true })
      }
      return true
    } catch (error) {
      logger.error(`[ClassTable] 文件导入课程表失败: ${error.stack || error}`)
      if (rawData) {
        logger.error(`[ClassTable] 文件 ${fileName} 顶层字段: ${describeShape(rawData)}`)
      }
      dumpFailedImport(fileName, fileContent)
      await ev.reply(`导入课程表失败：${error.message || error}`)
      return true
    }
  }

  async importWakeUpSchedule(e) {
    const recallSuccess = await safeRecallEventMsg(e, { maxAgeSeconds: 110 })

    try {
      const match = e.msg.match(WAKEUP_SHARE_REG)
      if (!match) {
        await e.reply("看不懂分享口令是什么呢，请检查你的分享口令是否完整qwq")
        return true
      }

      const shareCode = match[1]
      const jsonData = await this.getCourseScheduleFromApi(shareCode)
      if (!jsonData || jsonData.status !== 1 || jsonData.message !== "success" || !jsonData.data) {
        logger.warn(`[ClassTable] 导入课程表失败: ${JSON.stringify(jsonData)}`)
        await e.reply(`好像出问题了qwq\n错误: ${JSON.stringify(jsonData)}`)
        return true
      }

      const courseSchedule = generateCourseScheduleFromWakeupData(jsonData)
      saveUserScheduleData(e.user_id, e.isGroup ? e.group_id : null, courseSchedule)

      const importSuccessMsg = !e.isGroup
        ? "导入课程表成功，重复导入会覆盖之前的数据。"
        : recallSuccess
          ? "导入课程表成功，重复导入会覆盖之前的数据。\n为了隐私安全，已自动撤回你的分享口令。"
          : "导入课程表成功，重复导入会覆盖之前的数据。\n注意：Bot没有权限撤回你的分享口令消息，请手动撤回嗷"
      await e.reply(importSuccessMsg)
      return true
    } catch (error) {
      logger.error(`[ClassTable] WakeUp 导入课程表失败: ${error.stack || error}`)
      await e.reply("课程表导入失败了qwq\n检查一下分享口令是否正确呢喵")
      return true
    }
  }

  async downloadIncomingFile(e) {
    const url = await this.resolveIncomingFileUrl(e)
    if (!url) {
      throw new Error("无法获取文件下载地址，当前适配器没有提供文件直链或 fid")
    }

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`文件下载失败：HTTP ${response.status}`)
    }

    const sizeHeader = Number(response.headers.get("content-length") || 0)
    if (sizeHeader > MAX_IMPORT_FILE_SIZE) {
      throw new Error("导入文件过大，JSON 文件需小于 2MB")
    }

    const text = await response.text()
    if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_FILE_SIZE) {
      throw new Error("导入文件过大，JSON 文件需小于 2MB")
    }

    return text
  }

  async resolveIncomingFileUrl(e) {
    const segment = findFileSegment(e)

    /** 有些适配器（QQ 官方 bot 等）直接在 file 段里给公网地址，不需要换链 */
    const directUrl = [segment?.file, segment?.url, segment?.data?.url, segment?.data?.file]
      .find((value) => typeof value === "string" && /^https?:\/\//i.test(value))
    if (directUrl) return directUrl

    /** 其余情况拿 fid / file_id / id 找适配器换直链，字段名各适配器不统一 */
    const fileIds = [
      e.file?.fid,
      segment?.fid,
      segment?.file_id,
      segment?.fileId,
      segment?.id,
      typeof segment?.file === "string" ? segment.file : null
    ].filter((value) => typeof value === "string" && value)

    const candidates = []
    for (const fid of fileIds) {
      candidates.push(
        () => e.friend?.getFileUrl?.(fid),
        () => e.group?.getFileUrl?.(fid),
        () => e.bot?.pickFriend?.(e.user_id)?.getFileUrl?.(fid),
        () => e.isGroup ? e.bot?.pickGroup?.(e.group_id)?.getFileUrl?.(fid) : null,
        () => Bot?.pickFriend?.(e.user_id)?.getFileUrl?.(fid),
        () => e.isGroup ? Bot?.pickGroup?.(e.group_id)?.getFileUrl?.(fid) : null
      )
    }

    for (const getter of candidates) {
      try {
        const result = await getter?.()
        if (typeof result === "string" && result) return result
        if (result?.url) return result.url
      } catch {
      }
    }

    return null
  }

  async getCourseScheduleFromApi(shareCode) {
    const baseUrl = String(config.WAKEUP_URL || "").replace(/\/+$/, "")
    const token = config.APITOKEN

    if (!baseUrl || !token) {
      throw new Error("classtable 配置缺少 WAKEUP_URL 或 APITOKEN")
    }

    const url = `${baseUrl}/share?shareCode=${encodeURIComponent(shareCode)}`
    const responseData = await getJson(url, {
      "X-Auth-Token": token
    }, 5000)

    if (!responseData || responseData.success !== true || responseData.code !== 200 || responseData.message !== "获取成功" || !responseData.data?.shareData) {
      return responseData
    }

    return {
      status: 1,
      message: "success",
      data: responseData.data.shareData
    }
  }

}
