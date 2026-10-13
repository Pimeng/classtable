/**
 * 拾光课程表导入解析回归测试。
 * 关键点：拾光 App 导出的课程靠节次（startSection/endSection）表示时间，
 * customStartTime/customEndTime 在 isCustomTime=false 时是 null，必须回 timeSlots 查。
 */
import assert from "node:assert/strict"
import {
  convertInternalToShiguang,
  convertNativeToInternal,
  convertShiguangToInternal,
  detectScheduleFormat
} from "../utils/scheduleFormat.js"

const TIME_SLOTS = [
  { number: 1, startTime: "08:00", endTime: "08:45", alias: null },
  { number: 2, startTime: "08:50", endTime: "09:35", alias: null },
  { number: 10, startTime: "18:30", endTime: "19:15", alias: null },
  { number: 13, startTime: "21:10", endTime: "21:55", alias: null }
]

/** 与真实导出同构：节次 + timeSlots + custom 时间为 null */
const realish = {
  courses: [
    { name: "课程甲", teacher: "", position: "", day: 1, startSection: 13, endSection: 13, weeks: [7], isCustomTime: false, customStartTime: null, customEndTime: null, color: 2, remark: null, credit: null },
    { name: "课程乙", teacher: "", position: "", day: 4, startSection: 10, endSection: 10, weeks: [7], isCustomTime: false, customStartTime: null, customEndTime: null, color: 8, remark: null, credit: null }
  ],
  timeSlots: TIME_SLOTS,
  config: { semesterStartDate: "2026-08-31", semesterTotalWeeks: 20, defaultClassDuration: 45, defaultBreakDuration: 10, firstDayOfWeek: 1 },
  comboSchedule: null
}

const lessonOf = (schedule, week, day) => Object.values(schedule[week]?.[day] || {}).flat()

// 1. 真实结构能识别也能导入
assert.equal(detectScheduleFormat(realish), "shiguang", "真实拾光导出应识别为 shiguang")
{
  const data = convertShiguangToInternal(realish)
  assert.equal(data.startDate, "2026-08-31", "学期开始日期应取自 config.semesterStartDate")
  assert.equal(data.maxWeek, 20, "总周数应取自 config.semesterTotalWeeks")

  const [mon] = lessonOf(data.schedule, 7, 1)
  assert.equal(mon.courseName, "课程甲")
  assert.equal(mon.startTime, "21:10", "节次 13 应查到 timeSlots 的 21:10")
  assert.equal(mon.endTime, "21:55")

  const [thu] = lessonOf(data.schedule, 7, 4)
  assert.equal(thu.courseName, "课程乙")
  assert.equal(thu.startTime, "18:30", "节次 10 应查到 18:30")
  assert.equal(thu.endTime, "19:15")
}

// 2. 跨多个节次：取起始节次的开始时间、结束节次的结束时间
{
  const span = {
    ...realish,
    courses: [{ name: "连堂课", teacher: "", position: "", day: 2, startSection: 1, endSection: 2, weeks: [1], isCustomTime: false, customStartTime: null, customEndTime: null }]
  }
  const data = convertShiguangToInternal(span)
  const [lesson] = lessonOf(data.schedule, 1, 2)
  assert.equal(lesson.startTime, "08:00", "跨节次应从第 1 节开始")
  assert.equal(lesson.endTime, "09:35", "跨节次应到第 2 节结束")
}

// 3. isCustomTime 为真时优先用自定时间，不受节次影响
{
  const custom = {
    ...realish,
    courses: [{ name: "自定时间课", teacher: "", position: "A101", day: 3, startSection: 1, endSection: 1, weeks: [3], isCustomTime: true, customStartTime: "07:30", customEndTime: "08:15" }]
  }
  const data = convertShiguangToInternal(custom)
  const [lesson] = lessonOf(data.schedule, 3, 3)
  assert.equal(lesson.startTime, "07:30", "自定时间应覆盖节次")
  assert.equal(lesson.endTime, "08:15")
  assert.equal(lesson.room, "A101", "position 应映射为教室")
}

// 4. 没有 timeSlots 时退化成 course.startTime/endTime
{
  const plain = {
    courses: [{ name: "裸时间课", teacher: "王老师", position: "B202", day: 5, weeks: [2, 4], startTime: "10:00", endTime: "10:45" }]
  }
  const data = convertShiguangToInternal(plain)
  const [lesson] = lessonOf(data.schedule, 2, 5)
  assert.equal(lesson.startTime, "10:00")
  assert.equal(lesson.endTime, "10:45")
  assert.equal(lesson.teacher, "王老师")
}

// 5. 插件自家导出的拾光格式仍能原样回导（isCustomTime=true 路径）
{
  const original = convertNativeToInternal({
    tableName: "回导测试",
    semesterStart: "2026-09-01",
    maxWeek: 18,
    courses: [{ name: "高数", teacher: "张老师", location: "A101", day: 1, startTime: "08:00", endTime: "09:35", weeks: [1, 2, 3] }]
  })
  const exported = convertInternalToShiguang(original)
  assert.equal(detectScheduleFormat(exported), "shiguang", "自家导出也走 shiguang")

  const back = convertShiguangToInternal(exported)
  const [lesson] = lessonOf(back.schedule, 2, 1)
  assert.equal(lesson.courseName, "高数")
  assert.equal(lesson.startTime, "08:00")
  assert.equal(lesson.endTime, "09:35")
  assert.equal(lesson.room, "A101")
  assert.equal(back.startDate, "2026-09-01")
  assert.equal(back.maxWeek, 18)
}

// 6. 插件标准格式不受影响
{
  const native = {
    tableName: "原生课表",
    semesterStart: "2026-09-01",
    maxWeek: 16,
    courses: [{ name: "英语", teacher: "李老师", location: "C303", day: 3, startTime: "14:00", endTime: "14:45", weeks: [1] }]
  }
  assert.equal(detectScheduleFormat(native), "native")
  const data = convertNativeToInternal(native)
  const [lesson] = lessonOf(data.schedule, 1, 3)
  assert.equal(lesson.courseName, "英语")
  assert.equal(lesson.startTime, "14:00")
}

// 7. 有课但一门都解析不出时间时，报错要说明数量而不是含糊说「没有课程」
{
  const broken = {
    courses: [
      { name: "课一", day: 1, weeks: [1], startSection: 99, endSection: 99 },
      { name: "课二", day: 2, weeks: [1] }
    ],
    timeSlots: TIME_SLOTS
  }
  assert.throws(
    () => convertShiguangToInternal(broken),
    /有 2 门课/,
    "应说明有几门课解析失败"
  )
}

// 8. 真正没有课程时保持原提示
assert.throws(() => convertShiguangToInternal({ courses: [], timeSlots: TIME_SLOTS }), /没有可导入的课程/)

console.log("scheduleFormat.js: 全部断言通过")
