import plugin from "../../../lib/plugins/plugin.js"
import { postJson, safeRecallEventMsg } from "../utils/appHelpers.js"
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

ensureScheduleDataDirs()

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
    this.setContext("importScheduleFile", e.isGroup)
    await e.reply("请发送 JSON 课表文件，Bot会自动识别插件标准格式或拾光格式")
  }

  async receiveScheduleFile(e) {
    if (!e.file?.name) return false

    const waitingImport = this.getContext("importScheduleFile", e.isGroup)
    const isAutoImportFile = /^classtable-.*\.json$/i.test(e.file.name)
    if (!waitingImport && !isAutoImportFile) return false

    if (!/\.json$/i.test(e.file.name)) {
      if (waitingImport) {
        this.finish("importScheduleFile", e.isGroup)
        await e.reply("导入失败：请发送 `.json` 格式的课程表文件喵")
      }
      return false
    }

    if (waitingImport) {
      this.finish("importScheduleFile", e.isGroup)
    }

    try {
      const fileContent = await this.downloadIncomingFile(e)
      const rawData = JSON.parse(fileContent)
      const format = detectScheduleFormat(rawData)

      if (!format) {
        await e.reply("导入失败：暂时无法识别这个 JSON 课表格式。支持插件标准格式、拾光格式，以及旧版内部存档格式。")
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

      saveUserScheduleData(e.user_id, e.isGroup ? e.group_id : null, courseSchedule)

      const importedFrom = format === "native"
        ? "插件标准格式"
        : format === "shiguang"
          ? "拾光格式"
          : "旧版内部格式"

      await e.reply(`导入课程表成功，已识别为${importedFrom}。重复导入会覆盖之前的数据。`)
      if (e.isGroup) {
        await e.reply("已收到文件，如有需要请手动撤回", false, { at: true })
      }
      return true
    } catch (error) {
      logger.error(`[ClassTable] 文件导入课程表失败: ${error.stack || error}`)
      await e.reply(`导入课程表失败：${error.message || error}`)
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
      throw new Error("无法获取文件下载地址，当前适配器可能不支持文件导入")
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
    const fid = e.file?.fid
    if (!fid) return null

    const candidates = [
      () => e.friend?.getFileUrl?.(fid),
      () => e.group?.getFileUrl?.(fid),
      () => e.bot?.pickFriend?.(e.user_id)?.getFileUrl?.(fid),
      () => e.isGroup ? e.bot?.pickGroup?.(e.group_id)?.getFileUrl?.(fid) : null,
      () => Bot?.pickFriend?.(e.user_id)?.getFileUrl?.(fid),
      () => e.isGroup ? Bot?.pickGroup?.(e.group_id)?.getFileUrl?.(fid) : null
    ]

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
    const url = config.WAKEUP_URL
    const token = config.APITOKEN

    if (!url || !token) {
      throw new Error("classtable 配置缺少 WAKEUP_URL 或 APITOKEN")
    }

    const responseData = await postJson(url, {
      shareToken: shareCode,
      apiToken: token || null
    }, 5000)

    if (!responseData || responseData.code !== 0 || responseData.message !== "success" || !responseData.data) {
      return responseData
    }

    const decodedData = Buffer.from(responseData.data, "base64").toString("utf8")
    return {
      ...responseData,
      status: 1,
      data: decodedData
    }
  }

}
