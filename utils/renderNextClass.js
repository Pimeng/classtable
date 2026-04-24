import {
  parseTimeString,
  isInClassTime,
  findConsecutiveClasses,
  timeToMinutes,
  calculateTimeInterval
} from './time.js'
import {
  groupQueryCache,
  getGroupCacheKey,
  getSkipClassCacheKey
} from './cache.js'
import {
  listUsersWithScheduleFromFiles as listUserIdsWithScheduleFromStorage,
  syncGroupUserListWithMembers as syncGroupUsersFromStorage,
  getGroupUserIds as readGroupUserIdsFromStorage,
  loadUserScheduleData,
  normalizeScheduleData,
  calculateWeekByStartDate as calcWeekByStartDate
} from "./scheduleStorage.js"

// 内部函数 Start

/**
 * 计算当前周次
 * @param {Date} startDate - 开学日期
 * @param {Date} currentDate - 当前日期
 * @returns {number} 当前周次
 */
function calculateCurrentWeek(startDate, currentDate) {
  const week = calcWeekByStartDate(currentDate, startDate)
  return week < 1 ? 1 : week
}

/**
 * 获取所有有课表数据的用户ID
 * @returns {Array} 用户ID数组
 */
function getAllUsersWithScheduleFromFiles() {
  const userIds = listUserIdsWithScheduleFromStorage()
  logger.info(`[ClassTable] 从文件中找到${userIds.length}个有课表数据的用户`)
  return userIds
}

/**
 * 自动同步群成员与课表用户，维护群组用户列表
 * @param {string} groupId - 群号
 * @param {Object} memberInfo - e.bot.gml.get(e.group_id) 返回的成员 Map
 * @returns {Array} 有课表数据的群成员 QQ 号数组
 */
async function syncGroupUserListWithMembers(groupId, memberInfo) {
  return syncGroupUsersFromStorage(groupId, memberInfo)
}

// 兼容原有接口，自动同步群成员与课表用户
async function getAllUsersWithSchedule(groupId, memberInfo = null) {
  try {
    // 如果传入了memberInfo，则自动同步
    if (memberInfo) {
      return await syncGroupUserListWithMembers(groupId, memberInfo)
    }
    return readGroupUserIdsFromStorage(groupId)
  } catch (error) {
    logger.error(`[ClassTable] 获取群组用户列表失败: ${error}`)
    return []
  }
}

// 内部函数 End


// 导出函数 Start

/**
 * 获取群组中多个用户的下一节课信息用于HTML渲染
 * @param {Object} e - 消息事件对象
 * @param {number} limit - 限制显示的用户数量，可选
 * @returns {Object} 包含渲染所需所有数据的对象
 */
async function getMultipleNextClassRenderData(e, limit = null) {
  try {
    const groupId = e.group_id
    // 自动同步群成员与课表用户
    const memberInfo = e.bot.gml.get(e.group_id)
    const userIds = await getAllUsersWithSchedule(groupId, memberInfo)
    
    // 如果没有用户有课表数据
    if (!userIds || userIds.length === 0) {
      logger.info(`[ClassTable] 群组${groupId}中没有找到有课表数据的用户`)
      const result = {
        list: [{
          userName: "暂无数据",
          hasClass: false,
          NoCourseTitle: "暂无课表数据",
          NoCourseTip: "群成员尚未导入课表"
        }]
      }
      logger.debug(`[ClassTable] 返回渲染数据: ${JSON.stringify(result, null, 2)}`)
      return result
    }
    
    const currentTime = new Date()
    const currentDay = currentTime.getDay() === 0 ? 7 : currentTime.getDay()
    const currentHour = currentTime.getHours()
    const currentMinute = currentTime.getMinutes()
    let userList = []
    
    logger.info(`[ClassTable] 开始处理${userIds.length}个用户的课表数据`)
    
    const cacheKey = getGroupCacheKey(groupId, limit)
    let cachedList = groupQueryCache.get(cacheKey)
    if (cachedList) {
      logger.debug(`[ClassTable] 使用缓存的渲染数据`)
      return { list: cachedList }
    }
    
    // 使用Promise.all并行处理用户数据
    const userPromises = userIds.map(async (userId) => {
      let userName = "未知用户"
      let avatarUrl = `https://q2.qlogo.cn/g?b=qq&nk=${userId}&s=100`
      try {
        const memberInfo = e.bot.gml.get(e.group_id)
        const member = memberInfo.get(Number(userId))
        userName = member?.card || member?.nickname || `用户${userId}`
        if (member && member.avatar) {
          avatarUrl = member.avatar
        }
      } catch (err) {
        userName = `用户${userId}`
      }
      
      try {
        return await buildUserNextClassCard({
          userId,
          userName,
          avatarUrl,
          currentTime,
          currentDay,
          currentHour,
          currentMinute,
          noClassTitle: "今日无课",
          noClassTip: "好好休息一下吧"
        })
      } catch (error) {
        logger.error(`[ClassTable] 获取用户${userId}的课表数据失败: ${error}`)
        return {
          userName: userName,
          hasClass: false,
          NoCourseTitle: "数据错误",
          NoCourseTip: "获取课表信息时发生错误"
        }
      }
    })
    
    // 等待所有用户处理完成
    const userResults = await Promise.all(userPromises)
    userList.push(...userResults.filter(item => item !== undefined))
    
    // 对用户列表进行排序：先按状态，再按上课时间，最后按用户名兜底
    userList.sort((a, b) => compareUsersByStatusAndTime(a, b, { fallback: "name", logTimeParseError: true }))
    
    // 缓存结果5分钟
    groupQueryCache.set(cacheKey, userList, 5 * 60 * 1000)
    
    // 如果指定了限制数量，只返回前N个用户
    if (limit && limit > 0 && userList.length > limit) {
      userList = userList.slice(0, limit)
    }
    
    const result = {
      list: userList
    }
    logger.debug(`[ClassTable] 返回渲染数据: ${JSON.stringify(result, null, 2)}`)
    return result
  } catch (error) {
    logger.error(`[ClassTable] 获取多人下一节课渲染数据失败: ${error}`)
    return {
      list: [{
        userName: "系统错误",
        hasClass: false,
        NoCourseTitle: "系统错误",
        NoCourseTip: "获取课表信息时发生错误"
      }]
    }
  }
}

/**
 * 获取所有用户的下一节课信息用于HTML渲染
 * @param {Object} e - 消息事件对象
 * @param {number} limit - 限制显示的用户数量，可选
 * @returns {Object} 包含渲染所需所有数据的对象
 */
async function getAllUsersNextClassRenderData(e, limit = null) {
  try {
    // 获取所有有课表数据的用户ID
    const userIds = getAllUsersWithScheduleFromFiles()
    
    // 如果没有用户有课表数据
    if (!userIds || userIds.length === 0) {
      logger.info(`[ClassTable] 没有找到有课表数据的用户`)
      const result = {
        list: [{
          userName: "暂无数据",
          hasClass: false,
          NoCourseTitle: "暂无课表数据",
          NoCourseTip: "系统中没有用户导入课表"
        }]
      }
      logger.debug(`[ClassTable] 返回渲染数据: ${JSON.stringify(result, null, 2)}`)
      return result
    }
    
    const currentTime = new Date()
    const currentDay = currentTime.getDay() === 0 ? 7 : currentTime.getDay()
    const currentHour = currentTime.getHours()
    const currentMinute = currentTime.getMinutes()
    let userList = []
    
    logger.info(`[ClassTable] 开始处理${userIds.length}个用户的课表数据`)
    
    // 使用Promise.all并行处理用户数据
    const userPromises = userIds.map(async (userId) => {
      let userName = `id${userId}`
      let avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=100`
      
      try {
        return await buildUserNextClassCard({
          userId,
          userName,
          avatarUrl,
          currentTime,
          currentDay,
          currentHour,
          currentMinute,
          noClassTitle: "好耶！没课喵",
          noClassTip: "休息吧喵"
        })
      } catch (error) {
        logger.error(`[ClassTable] 获取用户${userId}的课表数据失败: ${error}`)
        return {
          userName: userName,
          hasClass: false,
          NoCourseTitle: "数据错误",
          NoCourseTip: "获取课表信息时发生错误"
        }
      }
    })
    
    // 等待所有用户处理完成
    const userResults = await Promise.all(userPromises)
    userList.push(...userResults.filter(item => item !== undefined))
    
    // 对用户列表进行排序：先按状态，再按上课时间，最后保持原顺序
    userList.sort((a, b) => compareUsersByStatusAndTime(a, b, { fallback: "none", logTimeParseError: false }))
    
    // 如果指定了限制数量，只返回前N个用户
    if (limit && limit > 0 && userList.length > limit) {
      userList = userList.slice(0, limit)
    }
    
    const result = {
      list: userList
    }
    logger.debug(`[ClassTable] 返回渲染数据: ${JSON.stringify(result, null, 2)}`)
    return result
  } catch (error) {
    logger.error(`[ClassTable] 获取所有人下一节课渲染数据失败: ${error}`)
    return {
      list: [{
        userName: "系统错误",
        hasClass: false,
        NoCourseTitle: "系统错误",
        NoCourseTip: "获取课表信息时发生错误"
      }]
    }
  }
}


/**
 * 查找下一节课
 * @param {Object} schedule - 课表数据
 * @param {number} currentWeek - 当前周次
 * @param {number} currentDay - 当前星期几(1-7)
 * @param {number} currentHour - 当前小时
 * @param {number} currentMinute - 当前分钟
 * @returns {Object|null} 下一节课信息或 { status: 'noneToday' }
 */
function findNextClass(schedule, currentWeek, currentDay, currentHour, currentMinute) {
  // 若不存在当周数据或当日数据，直接判定今天没有课程
  if (!schedule[currentWeek] || !schedule[currentWeek][currentDay]) {
    return { status: 'noneToday' }
  }

  const todayClasses = []
  for (const [node, classes] of Object.entries(schedule[currentWeek][currentDay])) {
    for (const cls of classes) {
      // 检查单双周条件：type: 0=全周, 1=单周, 2=双周
      const classType = cls.type || 0
      let isValidWeek = true
      
      if (classType === 1 && (currentWeek % 2) === 0) {
        // 单周(odd)，当前周为偶数，跳过
        isValidWeek = false
      } else if (classType === 2 && (currentWeek % 2) === 1) {
        // 双周(even)，当前周为奇数，跳过
        isValidWeek = false
      }
      
      if (isValidWeek) {
        todayClasses.push({
          ...cls,
          node: parseInt(node)
        })
      }
    }
  }

  // 如果今天根本没有课程
  if (todayClasses.length === 0) {
    return { status: 'noneToday' }
  }

  todayClasses.sort((a, b) => a.node - b.node)

  // 优先查找当前正在上的课程
  for (let i = 0; i < todayClasses.length; i++) {
    const cls = todayClasses[i]
    if (isInClassTime(cls.startTime, cls.endTime, currentHour, currentMinute)) {
      // 找到了当前正在上的课程，检查是否有连续的相同课程
      const consecutiveResult = findConsecutiveClasses(todayClasses, i)
      return {
        ...consecutiveResult.finalClass,
        startTime: consecutiveResult.startTime,
        endTime: consecutiveResult.finalEndTime,
        week: currentWeek,
        status: 'ongoing'
      }
    }
  }

  // 没有正在上的课程，找下一节
  for (let i = 0; i < todayClasses.length; i++) {
    const cls = todayClasses[i]
    const { hour: startHour, minute: startMinute } = parseTimeString(cls.startTime)
    if (startHour > currentHour || (startHour === currentHour && startMinute > currentMinute)) {
      // 找到了下一节课，检查是否有连续的相同课程
      const consecutiveResult = findConsecutiveClasses(todayClasses, i)
      return {
        ...consecutiveResult.finalClass,
        startTime: consecutiveResult.startTime,
        endTime: consecutiveResult.finalEndTime,
        week: currentWeek,
        status: 'next'
      }
    }
  }

  // 今天有课程但已经结束
  return { status: 'noneToday' }
}

// 导出函数 End

export {
  getMultipleNextClassRenderData,
  getAllUsersNextClassRenderData,
  findNextClass
}

const STATUS_PRIORITY = {
  "上课中": 1,
  "翘课中": 2,
  "将开始": 3,
  "空闲": 4
}

function compareUsersByStatusAndTime(a, b, { fallback = "none", logTimeParseError = false } = {}) {
  const statusA = a.hasClass ? a.type : "空闲"
  const statusB = b.hasClass ? b.type : "空闲"

  const priorityA = STATUS_PRIORITY[statusA] || 999
  const priorityB = STATUS_PRIORITY[statusB] || 999
  if (priorityA !== priorityB) {
    return priorityA - priorityB
  }

  if (a.hasClass && b.hasClass && a.startTime && b.startTime) {
    try {
      const totalMinutesA = timeToMinutes(a.startTime)
      const totalMinutesB = timeToMinutes(b.startTime)
      if (totalMinutesA !== totalMinutesB) {
        return totalMinutesA - totalMinutesB
      }
    } catch (error) {
      if (logTimeParseError) {
        logger.warn(`[ClassTable] 时间格式解析失败: A=${a.startTime}, B=${b.startTime}`)
      }
    }
  }

  if (fallback === "name") {
    const nameA = a.userName || ""
    const nameB = b.userName || ""
    return nameA.localeCompare(nameB)
  }
  return 0
}

function trimDisplayName(text, maxLen) {
  const name = String(text || "")
  return name.length > maxLen ? `${name.substring(0, maxLen)}...` : name
}

async function buildUserNextClassCard({
  userId,
  userName,
  avatarUrl,
  currentTime,
  currentDay,
  currentHour,
  currentMinute,
  noClassTitle,
  noClassTip
}) {
  const scheduleData = loadUserScheduleData(userId, { useCache: true })
  if (!scheduleData) {
    return {
      userName,
      avatar: avatarUrl,
      hasClass: false,
      NoCourseTitle: "未导入课表",
      NoCourseTip: "该用户尚未导入课表"
    }
  }

  const { schedule, startDate: userStartDate } = normalizeScheduleData(scheduleData)
  const currentWeek = calculateCurrentWeek(new Date(userStartDate), currentTime)
  const nextClassInfo = findNextClass(schedule, currentWeek, currentDay, currentHour, currentMinute)

  if (!nextClassInfo || nextClassInfo.status === "noneToday") {
    return {
      userName: trimDisplayName(userName, 12),
      avatar: avatarUrl,
      hasClass: false,
      type: "空闲",
      typeColor: "#50ff05ff",
      NoCourseTitle: noClassTitle,
      NoCourseTip: noClassTip
    }
  }

  let nowType = "将开始"
  let typeColor = "#ffb700ff"
  if (nextClassInfo.status === "ongoing") {
    nowType = "上课中"
    typeColor = "#00eeffff"
  }

  const skipKey = getSkipClassCacheKey(userId)
  let isSkippingClass = false
  try {
    isSkippingClass = !!(await redis.get(skipKey))
  } catch (error) {
    logger.error(`[ClassTable] 检查翘课状态失败: ${error}`)
  }

  if (isSkippingClass && (nextClassInfo.status === "ongoing" || nextClassInfo.status === "next")) {
    nowType = "翘课中"
    typeColor = "#ff4757ff"
  }

  let timeUntilEnd = null
  if (nextClassInfo.status === "ongoing") {
    const currentTimeStr = `${currentHour}:${currentMinute}`
    timeUntilEnd = calculateTimeInterval(currentTimeStr, nextClassInfo.endTime)
  }

  return {
    userName: trimDisplayName(userName, 12),
    avatar: avatarUrl,
    hasClass: true,
    className: trimDisplayName(nextClassInfo.courseName, 8),
    type: nowType,
    typeColor,
    startTime: nextClassInfo.startTime,
    endTime: nextClassInfo.endTime,
    timeUntilEnd
  }
}

