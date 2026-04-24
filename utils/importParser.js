function parseNestedJson(data) {
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

export function generateCourseScheduleFromWakeupData(data) {
  const parsedData = parseNestedJson(data)
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
