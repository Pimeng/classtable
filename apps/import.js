import fs from "node:fs"
import path from "node:path"
import plugin from "../../../lib/plugins/plugin.js"
import { postJson, safeRecallEventMsg } from "../utils/appHelpers.js"
import config from "../utils/config.js"
import {
  convertNativeToInternal,
  convertShiguangToInternal,
  detectScheduleFormat
} from "../utils/scheduleFormat.js"

const DATA_DIR = path.join("./plugins", "classtable", "data")
const USER_DATA_DIR = path.join(DATA_DIR, "users")
const GROUP_DATA_DIR = path.join(DATA_DIR, "groups")
const MAX_IMPORT_FILE_SIZE = 2 * 1024 * 1024
const WAKEUP_SHARE_REG = /这是来自「WakeUp课程表」的课表分享，30分钟内有效哦，如果失效请朋友再分享一遍叭。为了保护隐私我们选择不监听你的剪贴板，请复制这条消息后，打开App的主界面，右上角第二个按钮 -> 从分享口令导入，按操作提示即可完成导入~分享口令为「(.*)」/

for (const dir of [DATA_DIR, USER_DATA_DIR, GROUP_DATA_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
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

      this.saveUserSchedule(e.user_id, e.isGroup ? e.group_id : null, courseSchedule)

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

      const courseSchedule = this.generateCourseScheduleFromData(jsonData)
      this.saveUserSchedule(e.user_id, e.isGroup ? e.group_id : null, courseSchedule)

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

  saveUserSchedule(userId, groupId, courseSchedule) {
    const userFilePath = path.join(USER_DATA_DIR, `${userId}.json`)
    fs.writeFileSync(userFilePath, JSON.stringify(courseSchedule, null, 2), "utf8")

    if (groupId) {
      this.addUserToGroupList(groupId, userId)
    }
  }

  addUserToGroupList(groupId, userId) {
    const groupUserListPath = path.join(GROUP_DATA_DIR, `${groupId}_userlist.json`)
    let userList = []

    if (fs.existsSync(groupUserListPath)) {
      try {
        userList = JSON.parse(fs.readFileSync(groupUserListPath, "utf8"))
      } catch (error) {
        logger.error(`[ClassTable] 读取群组用户列表失败: ${error.stack || error}`)
      }
    }

    if (!userList.includes(userId)) {
      userList.push(userId)
      fs.writeFileSync(groupUserListPath, JSON.stringify(userList, null, 2), "utf8")
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

  parseNestedJson(data) {
    const tryBuildLegacyParts = (rawText) => {
      const lines = String(rawText)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      const parsedChunks = []
      for (const line of lines) {
        try {
          parsedChunks.push(JSON.parse(line))
        } catch {
        }
      }

      if (parsedChunks.length < 4) return null

      const timeTableIdx = parsedChunks.findIndex((item) => Array.isArray(item) && item.length > 0 && item[0]?.node != null)
      const settingsIdx = parsedChunks.findIndex((item) => !Array.isArray(item) && item && (item.maxWeek != null || item.startDate != null || item.nodes != null))
      const coursesIdx = parsedChunks.findIndex((item) => Array.isArray(item) && item.length > 0 && item[0]?.courseName != null)
      const scheduleIdx = parsedChunks.findIndex((item) => Array.isArray(item) && item.length > 0 && item[0]?.day != null && item[0]?.startNode != null)

      if (timeTableIdx !== -1 && settingsIdx !== -1 && coursesIdx !== -1 && scheduleIdx !== -1) {
        return {
          timeTable: parsedChunks[timeTableIdx],
          settings: parsedChunks[settingsIdx],
          courses: parsedChunks[coursesIdx],
          schedule: parsedChunks[scheduleIdx]
        }
      }

      const lastFour = parsedChunks.slice(-4)
      return {
        timeTable: lastFour[0],
        settings: lastFour[1],
        courses: lastFour[2],
        schedule: lastFour[3]
      }
    }

    const resolvePayload = (payload, depth = 0) => {
      if (depth > 5 || payload == null) return null

      if (typeof payload === "object") {
        if (payload.timeTable && payload.settings && payload.courses && payload.schedule) {
          return {
            timeTable: payload.timeTable,
            settings: payload.settings,
            courses: payload.courses,
            schedule: payload.schedule
          }
        }

        if (payload.shareData != null) {
          const resolved = resolvePayload(payload.shareData, depth + 1)
          if (resolved) return resolved
        }

        if (payload.data != null) {
          const resolved = resolvePayload(payload.data, depth + 1)
          if (resolved) return resolved
        }

        return null
      }

      if (typeof payload === "string") {
        const text = payload.trim()

        try {
          const parsed = JSON.parse(text)
          const resolved = resolvePayload(parsed, depth + 1)
          if (resolved) return resolved
        } catch {
        }

        const legacy = tryBuildLegacyParts(text)
        if (legacy) return legacy

        if (text.includes("\\n")) {
          const unescaped = text.replace(/\\n/g, "\n")
          const escapedLegacy = tryBuildLegacyParts(unescaped)
          if (escapedLegacy) return escapedLegacy
        }
      }

      return null
    }

    const parsed = resolvePayload(data?.data)
    if (!parsed) {
      throw new Error("课程表数据格式异常，无法解析 timeTable/settings/courses/schedule")
    }

    return parsed
  }

  generateCourseScheduleFromData(data) {
    const parsedData = this.parseNestedJson(data)
    const { courses, schedule, timeTable, settings } = parsedData

    const courseDict = {}
    for (const course of courses) {
      courseDict[course.id] = course
    }

    const nodeTimeDict = {}
    for (const item of timeTable) {
      nodeTimeDict[item.node] = item
    }

    const maxWeek = settings.maxWeek || 18
    const startDate = settings.startDate || "2026-03-04"
    const courseSchedule = []

    for (const scheduleItem of schedule) {
      const courseId = scheduleItem.id
      const courseInfo = courseDict[courseId] || {}
      const { startNode, step, day, startWeek, endWeek, teacher, room, type } = scheduleItem
      const courseName = courseInfo.courseName || "未知课程"
      const classTimes = []

      if (scheduleItem.ownTime && scheduleItem.startTime && scheduleItem.endTime) {
        classTimes.push({
          node: startNode,
          startTime: scheduleItem.startTime,
          endTime: scheduleItem.endTime
        })
      } else {
        for (let index = 0; index < step; index += 1) {
          const node = startNode + index
          const timeInfo = nodeTimeDict[node] || { startTime: "00:00", endTime: "00:00" }
          classTimes.push({
            node,
            startTime: timeInfo.startTime,
            endTime: timeInfo.endTime
          })
        }
      }

      courseSchedule.push({
        courseId,
        courseName,
        day,
        startWeek,
        endWeek,
        classTimes,
        teacher: teacher || "",
        room: room || "",
        type: type || 0
      })
    }

    const weeklySchedule = {}
    for (let week = 1; week <= maxWeek; week += 1) {
      weeklySchedule[week] = {}
    }

    for (const entry of courseSchedule) {
      for (let week = entry.startWeek; week <= entry.endWeek; week += 1) {
        if (week > maxWeek || entry.day > 7) continue
        if (entry.type === 1 && week % 2 === 0) continue
        if (entry.type === 2 && week % 2 === 1) continue

        if (!weeklySchedule[week][entry.day]) {
          weeklySchedule[week][entry.day] = {}
        }

        for (const time of entry.classTimes) {
          if (!weeklySchedule[week][entry.day][time.node]) {
            weeklySchedule[week][entry.day][time.node] = []
          }

          weeklySchedule[week][entry.day][time.node].push({
            courseId: entry.courseId,
            courseName: entry.courseName,
            startTime: time.startTime,
            endTime: time.endTime,
            week,
            startWeek: entry.startWeek,
            endWeek: entry.endWeek,
            teacher: entry.teacher,
            room: entry.room,
            type: entry.type
          })
        }
      }
    }

    const cleanedWeeklySchedule = {}
    for (const [week, days] of Object.entries(weeklySchedule)) {
      if (Object.keys(days).length > 0) {
        cleanedWeeklySchedule[week] = days
      }
    }

    return {
      schedule: cleanedWeeklySchedule,
      startDate,
      maxWeek,
      updateTime: new Date().toISOString()
    }
  }
}
