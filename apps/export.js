import fs from "node:fs"
import path from "node:path"
import plugin from "../../../lib/plugins/plugin.js"
import {
  convertInternalToNative,
  convertInternalToShiguang
} from "../utils/scheduleFormat.js"
import {
  EXPORT_DIR,
  ensureScheduleDataDirs,
  hasUserSchedule,
  loadUserScheduleData
} from "../utils/scheduleStorage.js"

ensureScheduleDataDirs({ includeExport: true })

function buildExportFileName(userId, format) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return `classtable-${format}-${userId}-${stamp}.json`
}

export class classtableExport extends plugin {
  constructor() {
    super({
      name: "classtable:导出课表",
      dsc: "导出插件标准格式或拾光格式的课程表 JSON",
      event: "message",
      priority: 10,
      rule: [
        {
          reg: "^#?导出课表(?:\\s*(拾光))?$",
          fnc: "exportSchedule"
        },
        {
          reg: "^#?(确认导出课表|取消导出课表|确认导出|取消导出|确认|继续|取消)$",
          fnc: "confirmExportSchedule"
        }
      ]
    })
  }

  async exportSchedule(e) {
    const format = /拾光/.test(e.msg) ? "shiguang" : "native"

    if (e.isGroup) {
      const context = this.setContext("confirmExportSchedule", false, 30, "导出课表已取消")
      context.exportFormat = format
      context.exportUserId = e.user_id
      await e.reply("群聊导出会直接发送文件到当前群，请发送“确认导出课表”继续，发送“取消导出课表”终止。", false, { at: true })
      return true
    }

    return await this.performExport(e, format)
  }

  async confirmExportSchedule(context) {
    const e = this.e
    if (!context || !e?.isGroup) return false

    const message = e.msg.trim().replace(/^#/, "")
    if (context.exportUserId && String(context.exportUserId) !== String(e.user_id)) {
      if (["确认导出课表", "取消导出课表", "确认导出", "取消导出", "确认", "继续", "取消"].includes(message)) {
        await e.reply("只有发起导出的人才能确认或取消这次导出。", false, { at: true })
        return true
      }
      return "continue"
    }

    if (["取消导出课表", "取消导出", "取消"].includes(message)) {
      this.finish("confirmExportSchedule", false)
      await e.reply("已取消导出课表", false, { at: true })
      return true
    }

    if (!["确认导出课表", "确认导出", "确认", "继续"].includes(message)) {
      return "continue"
    }

    const format = context.exportFormat || "native"
    this.finish("confirmExportSchedule", false)
    return await this.performExport(e, format)
  }

  async performExport(e, format) {
    try {
      if (!hasUserSchedule(e.user_id)) {
        await e.reply("你还没有导入课表喵")
        return true
      }

      const internalData = loadUserScheduleData(e.user_id, { useCache: false })
      if (!internalData) {
        await e.reply("你还没有导入课表喵")
        return true
      }
      const exportAsShiguang = format === "shiguang"
      const jsonData = exportAsShiguang
        ? convertInternalToShiguang(internalData)
        : convertInternalToNative(internalData)

      const fileName = buildExportFileName(e.user_id, format)
      const savePath = path.join(EXPORT_DIR, fileName)
      fs.writeFileSync(savePath, JSON.stringify(jsonData, null, 2), "utf8")

      try {
        if (e.group?.sendFile) {
          await e.group.sendFile(savePath)
        } else if (e.friend?.sendFile) {
          await e.friend.sendFile(savePath)
        } else {
          await e.reply("导出失败：当前环境暂不支持发送文件喵")
          return true
        }
      } finally {
        if (fs.existsSync(savePath)) {
          fs.unlinkSync(savePath)
        }
      }
      
      return true
    } catch (error) {
      logger.error(`[ClassTable] 导出课程表失败: ${error.stack || error}`)
      await e.reply("导出课程表失败，请稍后再试喵")
      return true
    }
  }
}
