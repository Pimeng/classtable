import crypto from "node:crypto"

const DEFAULT_TABLE_NAME = "classtable课表"

function pad2(value) {
  return String(value).padStart(2, "0")
}

function todayString() {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

function normalizeDateString(value, fallback = todayString()) {
  if (typeof value !== "string") return fallback
  const text = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return fallback
  const date = new Date(`${text}T00:00:00`)
  return Number.isNaN(date.getTime()) ? fallback : text
}

function normalizeTimeString(value) {
  if (typeof value !== "string") return ""
  const match = value.trim().match(/^(\d{1,2}):(\d{1,2})$/)
  if (!match) return ""
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return ""
  return `${pad2(hour)}:${pad2(minute)}`
}

function timeToMinutes(time) {
  const normalized = normalizeTimeString(time)
  if (!normalized) return Number.MAX_SAFE_INTEGER
  const [hour, minute] = normalized.split(":").map(Number)
  return hour * 60 + minute
}

function sortUniqueNumbers(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b)
}

function normalizeWeeks(weeks) {
  if (!Array.isArray(weeks)) return []
  return sortUniqueNumbers(weeks)
}

function normalizeDay(value) {
  const day = Number(value)
  return Number.isInteger(day) && day >= 1 && day <= 7 ? day : null
}

function getCourseIdentity(course) {
  return [
    String(course.name || course.courseName || "").trim(),
    String(course.teacher || "").trim(),
    String(course.location || course.position || course.room || "").trim(),
    String(course.startTime || course.customStartTime || "").trim(),
    String(course.endTime || course.customEndTime || "").trim(),
    String(course.day || "").trim()
  ].join("__")
}

function calculateGapMinutes(previousEndTime, nextStartTime) {
  return timeToMinutes(nextStartTime) - timeToMinutes(previousEndTime)
}

function calculateMaxWeek(courses, fallback = 20) {
  const maxFromCourses = courses.reduce((max, course) => {
    const weeks = normalizeWeeks(course.weeks)
    return weeks.length > 0 ? Math.max(max, weeks[weeks.length - 1]) : max
  }, 0)

  const value = Number(fallback)
  if (Number.isInteger(value) && value > 0) {
    return Math.max(value, maxFromCourses || value)
  }

  return maxFromCourses || 20
}

function buildNodeMapping(courses) {
  const uniqueSlots = [...new Set(courses.map((course) => `${course.startTime}-${course.endTime}`))]
  uniqueSlots.sort((left, right) => {
    const [leftStart, leftEnd] = left.split("-")
    const [rightStart, rightEnd] = right.split("-")
    const startDiff = timeToMinutes(leftStart) - timeToMinutes(rightStart)
    if (startDiff !== 0) return startDiff
    return timeToMinutes(leftEnd) - timeToMinutes(rightEnd)
  })

  const slotToNode = new Map()
  uniqueSlots.forEach((slot, index) => slotToNode.set(slot, index + 1))
  return slotToNode
}

function normalizeCourseEntries(rawCourses) {
  if (!Array.isArray(rawCourses)) return []

  return rawCourses
    .map((course) => {
      const name = String(course.name || course.courseName || "").trim()
      const teacher = String(course.teacher || "").trim()
      const location = String(course.location || course.position || course.room || "").trim()
      const day = normalizeDay(course.day)
      const startTime = normalizeTimeString(course.startTime || course.customStartTime)
      const endTime = normalizeTimeString(course.endTime || course.customEndTime)
      const weeks = normalizeWeeks(course.weeks)

      if (!name || !day || !startTime || !endTime || weeks.length === 0) return null

      return {
        name,
        teacher,
        location,
        day,
        startTime,
        endTime,
        weeks
      }
    })
    .filter(Boolean)
}

export function buildInternalScheduleFromCourseEntries(rawCourses, options = {}) {
  const courses = normalizeCourseEntries(rawCourses)
  if (courses.length === 0) {
    const total = Array.isArray(rawCourses) ? rawCourses.length : 0
    if (total > 0) {
      throw new Error(`课程表里有 ${total} 门课，但没有一门能解析出时间或星期，请检查课程表版本`)
    }
    throw new Error("课程表中没有可导入的课程")
  }

  const startDate = normalizeDateString(options.semesterStart || options.startDate)
  const maxWeek = calculateMaxWeek(courses, options.maxWeek)
  const slotToNode = buildNodeMapping(courses)
  const schedule = {}

  for (const course of courses) {
    const startWeek = course.weeks[0]
    const endWeek = course.weeks[course.weeks.length - 1]
    const slotKey = `${course.startTime}-${course.endTime}`
    const node = slotToNode.get(slotKey)

    for (const week of course.weeks) {
      if (!schedule[week]) schedule[week] = {}
      if (!schedule[week][course.day]) schedule[week][course.day] = {}
      if (!schedule[week][course.day][node]) schedule[week][course.day][node] = []

      schedule[week][course.day][node].push({
        courseName: course.name,
        startTime: course.startTime,
        endTime: course.endTime,
        week,
        startWeek,
        endWeek,
        teacher: course.teacher,
        room: course.location,
        type: 0
      })
    }
  }

  return {
    schedule,
    startDate,
    maxWeek,
    tableName: String(options.tableName || DEFAULT_TABLE_NAME),
    nickname: String(options.nickname || ""),
    signature: String(options.signature || ""),
    updateTime: options.updateTime || new Date().toISOString()
  }
}

export function collectCourseEntriesFromInternal(data) {
  const schedule = data?.schedule || {}
  const weeklyEntries = []

  for (const [weekKey, days] of Object.entries(schedule)) {
    const week = Number(weekKey)
    if (!Number.isInteger(week)) continue

    for (const [dayKey, nodeMap] of Object.entries(days || {})) {
      const day = Number(dayKey)
      if (!Number.isInteger(day)) continue

      const classList = []
      for (const [nodeKey, classes] of Object.entries(nodeMap || {})) {
        const node = Number(nodeKey)
        for (const cls of classes || []) {
          classList.push({
            node,
            name: String(cls.courseName || "").trim(),
            teacher: String(cls.teacher || "").trim(),
            location: String(cls.room || "").trim(),
            startTime: normalizeTimeString(cls.startTime),
            endTime: normalizeTimeString(cls.endTime)
          })
        }
      }

      classList.sort((left, right) => {
        const nodeDiff = left.node - right.node
        if (nodeDiff !== 0) return nodeDiff
        return timeToMinutes(left.startTime) - timeToMinutes(right.startTime)
      })

      const merged = []
      for (const item of classList) {
        if (!item.name || !item.startTime || !item.endTime) continue

        const previous = merged[merged.length - 1]
        const sameCourse = previous
          && previous.name === item.name
          && previous.teacher === item.teacher
          && previous.location === item.location
        const isConsecutiveNode = sameCourse && item.node === previous.lastNode + 1
        const isNearTime = sameCourse && calculateGapMinutes(previous.endTime, item.startTime) <= 30

        if (sameCourse && (isConsecutiveNode || isNearTime)) {
          previous.endTime = timeToMinutes(item.endTime) > timeToMinutes(previous.endTime) ? item.endTime : previous.endTime
          previous.lastNode = item.node
          continue
        }

        merged.push({
          ...item,
          lastNode: item.node
        })
      }

      for (const item of merged) {
        weeklyEntries.push({
          name: item.name,
          teacher: item.teacher,
          location: item.location,
          day,
          startTime: item.startTime,
          endTime: item.endTime,
          week
        })
      }
    }
  }

  const grouped = new Map()
  for (const item of weeklyEntries) {
    const key = getCourseIdentity(item)
    if (!grouped.has(key)) {
      grouped.set(key, {
        name: item.name,
        teacher: item.teacher,
        location: item.location,
        day: item.day,
        startTime: item.startTime,
        endTime: item.endTime,
        weeks: []
      })
    }
    grouped.get(key).weeks.push(item.week)
  }

  return Array.from(grouped.values())
    .map((course) => ({
      ...course,
      weeks: sortUniqueNumbers(course.weeks)
    }))
    .sort((left, right) => {
      const dayDiff = left.day - right.day
      if (dayDiff !== 0) return dayDiff
      const timeDiff = timeToMinutes(left.startTime) - timeToMinutes(right.startTime)
      if (timeDiff !== 0) return timeDiff
      return left.name.localeCompare(right.name, "zh-CN")
    })
}

export function detectScheduleFormat(data) {
  if (!data || typeof data !== "object") return null

  if (data.schedule && (data.startDate || data.maxWeek)) {
    return "internal"
  }

  if (Array.isArray(data.courses) && data.courses.length > 0) {
    const firstCourse = data.courses[0] || {}
    if (
      "customStartTime" in firstCourse
      || "customEndTime" in firstCourse
      || "startSection" in firstCourse
      || "endSection" in firstCourse
      || "position" in firstCourse
      || data.config?.semesterStartDate
      || Array.isArray(data.timeSlots)
    ) {
      return "shiguang"
    }

    if ("startTime" in firstCourse || "endTime" in firstCourse || "location" in firstCourse || "tableName" in data || "semesterStart" in data) {
      return "native"
    }
  }

  return null
}

/** 拾光 App 的时间表：节次号 → 起止时间 */
function buildTimeSlotMap(timeSlots) {
  const slotMap = new Map()
  if (!Array.isArray(timeSlots)) return slotMap

  for (const slot of timeSlots) {
    if (!slot || typeof slot !== "object") continue
    const number = Number(slot.number ?? slot.section ?? slot.node)
    if (!Number.isInteger(number) || number <= 0) continue
    const startTime = normalizeTimeString(slot.startTime)
    const endTime = normalizeTimeString(slot.endTime)
    if (!startTime || !endTime) continue
    slotMap.set(number, { startTime, endTime })
  }

  return slotMap
}

/**
 * 拾光 App 导出的课程靠**节次**表示时间（startSection/endSection），
 * customStartTime/customEndTime 在 isCustomTime 为 false 时是 null，
 * 必须回 timeSlots 里查——上游只读 customStartTime，所以这类文件一门课都解析不出来。
 */
function resolveShiguangCourseTime(course, slotMap) {
  const customStart = normalizeTimeString(course.customStartTime)
  const customEnd = normalizeTimeString(course.customEndTime)
  if (customStart && customEnd) return { startTime: customStart, endTime: customEnd }

  const rawStart = Number(course.startSection ?? course.startNode ?? course.section)
  const startSection = Number.isInteger(rawStart) ? rawStart : null
  if (startSection) {
    const rawEnd = Number(course.endSection ?? course.endNode)
    const endSection = Number.isInteger(rawEnd) ? rawEnd : startSection
    const startSlot = slotMap.get(startSection)
    const endSlot = slotMap.get(endSection) || startSlot
    if (startSlot && endSlot) return { startTime: startSlot.startTime, endTime: endSlot.endTime }
  }

  const plainStart = normalizeTimeString(course.startTime)
  const plainEnd = normalizeTimeString(course.endTime)
  if (plainStart && plainEnd) return { startTime: plainStart, endTime: plainEnd }

  return null
}

export function convertNativeToInternal(data) {
  return buildInternalScheduleFromCourseEntries(data.courses, {
    semesterStart: data.semesterStart,
    maxWeek: data.maxWeek,
    tableName: data.tableName,
    nickname: data.nickname,
    signature: data.signature,
    updateTime: data.updateTime
  })
}

export function convertShiguangToInternal(data) {
  const slotMap = buildTimeSlotMap(data.timeSlots)
  const courses = (data.courses || []).map((course) => {
    const time = resolveShiguangCourseTime(course, slotMap)
    return {
      name: course.name,
      teacher: course.teacher,
      location: course.position,
      day: course.day,
      weeks: course.weeks,
      startTime: time?.startTime,
      endTime: time?.endTime
    }
  })

  return buildInternalScheduleFromCourseEntries(courses, {
    semesterStart: data.config?.semesterStartDate,
    maxWeek: data.config?.semesterTotalWeeks,
    tableName: data.tableName || "拾光课程表导入",
    nickname: data.nickname,
    signature: data.signature,
    updateTime: data.updateTime
  })
}

export function convertInternalToNative(data) {
  const courses = collectCourseEntriesFromInternal(data).map((course) => ({
    name: course.name,
    teacher: course.teacher,
    location: course.location,
    day: course.day,
    startTime: course.startTime,
    endTime: course.endTime,
    weeks: course.weeks
  }))

  return {
    tableName: String(data.tableName || DEFAULT_TABLE_NAME),
    semesterStart: normalizeDateString(data.startDate),
    maxWeek: Number(data.maxWeek) || calculateMaxWeek(courses),
    updateTime: new Date().toISOString(),
    nickname: String(data.nickname || ""),
    signature: String(data.signature || ""),
    courses
  }
}

export function convertInternalToShiguang(data) {
  const nativeData = convertInternalToNative(data)
  const slotMap = new Map()
  const courses = nativeData.courses.map((course, index) => {
    const slotKey = `${course.startTime}-${course.endTime}`
    if (!slotMap.has(slotKey)) {
      slotMap.set(slotKey, {
        number: slotMap.size + 1,
        startTime: course.startTime,
        endTime: course.endTime
      })
    }

    return {
      id: crypto.randomUUID(),
      name: course.name,
      teacher: course.teacher,
      position: course.location,
      day: course.day,
      weeks: course.weeks,
      color: (index % 12) + 1,
      isCustomTime: true,
      customStartTime: course.startTime,
      customEndTime: course.endTime
    }
  })

  const timeSlots = Array.from(slotMap.values()).sort((left, right) => left.number - right.number)

  return {
    tableName: nativeData.tableName,
    nickname: nativeData.nickname,
    signature: nativeData.signature,
    updateTime: nativeData.updateTime,
    courses,
    timeSlots,
    config: {
      semesterStartDate: nativeData.semesterStart,
      semesterTotalWeeks: nativeData.maxWeek,
      defaultClassDuration: 45,
      defaultBreakDuration: 10,
      firstDayOfWeek: 1
    }
  }
}
