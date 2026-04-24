import plugin from "../../../lib/plugins/plugin.js"
import {
  hasUserSchedule,
  loadUserScheduleData,
  normalizeScheduleData,
  calculateWeekByStartDate
} from "../utils/scheduleStorage.js"

export class classtableQuery extends plugin {
  constructor() {
    super({
      name: 'classtable:查询课表',
      dsc: '查询指定日期课表',
      event: 'message',
      priority: 10,
      rule: [
        {
          reg: '^(今天|明天|后天|昨天)课表$',
          fnc: 'queryRelativeSchedule'
        },
        {
          reg: '^\\d{4}-\\d{2}-\\d{2}\\s*课表$',
          fnc: 'queryDateSchedule'
        },
        {
          reg: '^查课表\\s+\\d{4}-\\d{2}-\\d{2}$',
          fnc: 'querySearchSchedule'
        }
      ]
    })
  }

  /**
   * 查询相对日期的课表（今天/明天/后天/昨天）
   * @param {Object} e
   */
  async queryRelativeSchedule(e) {
    const match = e.msg.trim().match(/^(今天|明天|后天|昨天)课表$/)
    if (!match) return

    const relative = match[1]
    const targetDate = new Date()
    const offset = { "昨天": -1, "今天": 0, "明天": 1, "后天": 2 }[relative]
    targetDate.setDate(targetDate.getDate() + offset)

    await this.renderDateSchedule(e, targetDate, relative)
  }

  /**
   * 查询指定日期的课表（YYYY-MM-DD课表）
   * @param {Object} e
   */
  async queryDateSchedule(e) {
    const match = e.msg.trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (!match) return

    const [, year, month, day] = match
    const targetDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day))
    const dateStr = `${year}-${month}-${day}`

    await this.renderDateSchedule(e, targetDate, dateStr)
  }

  /**
   * 查询指定日期的课表（查课表 YYYY-MM-DD）
   * @param {Object} e
   */
  async querySearchSchedule(e) {
    const match = e.msg.trim().match(/查课表\s+(\d{4})-(\d{2})-(\d{2})/)
    if (!match) return

    const [, year, month, day] = match
    const targetDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day))
    const dateStr = `${year}-${month}-${day}`

    await this.renderDateSchedule(e, targetDate, dateStr)
  }

  /**
   * 渲染指定日期的课表
   * @param {Object} e 消息事件
   * @param {Date} targetDate 目标日期
   * @param {string} dateStr 日期显示字符串
   */
  async renderDateSchedule(e, targetDate, dateStr) {
    try {
      const userId = e.user_id
      
      if (!hasUserSchedule(userId)) {
        await e.reply("你还没有导入课表哦，请先使用WakeUp课程表分享口令导入~")
        return
      }

      if (isNaN(targetDate.getTime())) {
        await e.reply("日期格式不正确")
        return
      }

      const scheduleData = loadUserScheduleData(userId, { useCache: true })
      if (!scheduleData) {
        await e.reply("你还没有导入课表哦，请先使用WakeUp课程表分享口令导入~")
        return
      }
      const { schedule, startDate, maxWeek } = normalizeScheduleData(scheduleData)

      // 计算周次和星期
      const dayOfWeek = targetDate.getDay() === 0 ? 7 : targetDate.getDay()
      const week = calculateWeekByStartDate(targetDate, startDate)

      // 检查日期有效性
      if (week < 1 || week > maxWeek) {
        await e.reply(`${dateStr} 不在本学期范围内（第1-${maxWeek}周）`)
        return
      }

      // 获取当天的课程
      const dayClasses = []
      if (schedule[week] && schedule[week][dayOfWeek]) {
        for (const [node, classes] of Object.entries(schedule[week][dayOfWeek])) {
          for (const cls of classes) {
            dayClasses.push({
              ...cls,
              node: parseInt(node)
            })
          }
        }
      }

      if (dayClasses.length === 0) {
        await e.reply(`${dateStr}（第${week}周 周${["", "一", "二", "三", "四", "五", "六", "日"][dayOfWeek]}）没有课程哦~`)
        return
      }

      // 按节次排序
      dayClasses.sort((a, b) => a.node - b.node)

      const parseMinutes = (time) => {
        const [h, m] = String(time || '').split(':').map(n => parseInt(n, 10))
        if (Number.isNaN(h) || Number.isNaN(m)) return Number.MAX_SAFE_INTEGER
        return h * 60 + m
      }

      const normalizeText = (text) => String(text || '').trim()

      // 按“课程名+教师+教室”合并同一天内相同课程，时间取最早开始到最晚结束
      const mergedMap = new Map()
      for (const cls of dayClasses) {
        const courseName = normalizeText(cls.courseName)
        const teacher = normalizeText(cls.teacher)
        const room = normalizeText(cls.room)
        const mergeKey = `${courseName}__${teacher}__${room}`

        if (!mergedMap.has(mergeKey)) {
          mergedMap.set(mergeKey, {
            ...cls,
            nodeList: [cls.node],
            firstNode: cls.node,
            startMin: parseMinutes(cls.startTime),
            endMin: parseMinutes(cls.endTime)
          })
          continue
        }

        const merged = mergedMap.get(mergeKey)
        const startMin = parseMinutes(cls.startTime)
        const endMin = parseMinutes(cls.endTime)

        if (startMin < merged.startMin) {
          merged.startMin = startMin
          merged.startTime = cls.startTime
        }
        if (endMin > merged.endMin) {
          merged.endMin = endMin
          merged.endTime = cls.endTime
        }

        if (cls.node < merged.firstNode) {
          merged.firstNode = cls.node
        }
        merged.nodeList.push(cls.node)
      }

      const mergedClasses = Array.from(mergedMap.values()).sort((a, b) => {
        if (a.startMin !== b.startMin) return a.startMin - b.startMin
        return a.firstNode - b.firstNode
      })

      const formatNodeStr = (nodeList) => {
        const nodes = [...new Set(nodeList)].sort((a, b) => a - b)
        if (nodes.length === 0) return ''

        const parts = []
        let rangeStart = nodes[0]
        let prev = nodes[0]

        for (let i = 1; i < nodes.length; i++) {
          const node = nodes[i]
          if (node === prev + 1) {
            prev = node
            continue
          }

          parts.push(rangeStart === prev ? `${rangeStart}` : `${rangeStart}-${prev}`)
          rangeStart = node
          prev = node
        }

        parts.push(rangeStart === prev ? `${rangeStart}` : `${rangeStart}-${prev}`)
        return `第${parts.join('、')}节`
      }

      // 生成合并转发消息
      const forwardMsgs = []
      const weekDayStr = ["", "一", "二", "三", "四", "五", "六", "日"][dayOfWeek]
      
      forwardMsgs.push(`${dateStr} 课程表\n第${week}周 周${weekDayStr}`)
      
      for (const cls of mergedClasses) {
        const nodeStr = formatNodeStr(cls.nodeList)
        const msg = `📚 ${cls.courseName}\n` +
                   `⏰ ${cls.startTime} - ${cls.endTime}（${nodeStr}）`
        forwardMsgs.push(msg)
      }

      // 发送合并转发
      const common = await import("../../../lib/common/common.js")
      const forwardMsg = await common.default.makeForwardMsg(e, forwardMsgs, `${dateStr} 课程表`, false)
      
      if (forwardMsg) {
        await e.reply(forwardMsg)
      } else {
        await e.reply(forwardMsgs.join("\n---"))
      }

    } catch (error) {
      logger.error(`[ClassTable] 查询日期课表失败: ${error}`)
      await e.reply("查询课表失败，请稍后再试")
    }
  }
}
