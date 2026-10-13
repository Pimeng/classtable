import fs from "node:fs"
import path from "node:path"
import { userScheduleCache, getUserScheduleCacheKey } from "./cache.js"
import { userIdCandidates } from "./identity.js"

export const DATA_DIR = path.join("./plugins", "classtable", "data")
export const USER_DATA_DIR = path.join(DATA_DIR, "users")
export const GROUP_DATA_DIR = path.join(DATA_DIR, "groups")
export const EXPORT_DIR = path.join(DATA_DIR, "exports")
export const DEFAULT_START_DATE = "2025-09-01"
export const DEFAULT_MAX_WEEK = 20

export function ensureScheduleDataDirs({ includeExport = false } = {}) {
  const dirs = includeExport
    ? [DATA_DIR, USER_DATA_DIR, GROUP_DATA_DIR, EXPORT_DIR]
    : [DATA_DIR, USER_DATA_DIR, GROUP_DATA_DIR]
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }
}

export function getUserSchedulePath(userId) {
  return path.join(USER_DATA_DIR, `${userId}.json`)
}

export function getGroupUserListPath(groupId) {
  return path.join(GROUP_DATA_DIR, `${groupId}_userlist.json`)
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

export function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8")
}

export function hasUserSchedule(userId) {
  return fs.existsSync(getUserSchedulePath(userId))
}

/**
 * 按候选 id 找出真正落盘的那一份课表
 *
 * 同一个人在不同适配器/不同版本下会写成不同形式的 id（裸 openid 与
 * `{self_id}:{openid}` 都出现过），调用方传入 candidates（见 identity.js 的
 * userIdCandidates）后，这里返回**实际存在文件**的那个 id，供后续读取复用。
 *
 * @param {string} userId 运行时 id，优先尝试
 * @param {Array<string>} candidates 其它可能的写法
 * @returns {string|null}
 */
export function resolveStoredUserId(userId, candidates = []) {
  const ids = [userId, ...candidates].map((id) => String(id ?? "").trim()).filter(Boolean)
  for (const id of [...new Set(ids)]) {
    if (hasUserSchedule(id)) return id
  }
  return null
}

export function normalizeScheduleData(scheduleData) {
  return {
    schedule: scheduleData?.schedule || scheduleData || {},
    startDate: scheduleData?.startDate || DEFAULT_START_DATE,
    maxWeek: scheduleData?.maxWeek || DEFAULT_MAX_WEEK
  }
}

export function calculateWeekByStartDate(targetDate, startDate) {
  const beginDate = new Date(startDate || DEFAULT_START_DATE)
  const deltaDays = Math.floor((targetDate - beginDate) / (1000 * 60 * 60 * 24))
  return Math.floor(deltaDays / 7) + 1
}

export function loadUserScheduleData(userId, { useCache = true } = {}) {
  const filePath = getUserSchedulePath(userId)
  if (!fs.existsSync(filePath)) return null

  const cacheKey = getUserScheduleCacheKey(userId)
  if (useCache) {
    const cached = userScheduleCache.get(cacheKey)
    if (cached) return cached
  }

  const scheduleData = readJsonFile(filePath)
  if (useCache) {
    userScheduleCache.set(cacheKey, scheduleData)
  }
  return scheduleData
}

export function addUserToGroupList(groupId, userId) {
  const groupUserListPath = getGroupUserListPath(groupId)
  let userList = []

  if (fs.existsSync(groupUserListPath)) {
    try {
      userList = readJsonFile(groupUserListPath)
    } catch (error) {
      logger.error(`[ClassTable] 读取群组用户列表失败: ${error.stack || error}`)
    }
  }

  const userIdStr = String(userId)
  if (!userList.includes(userIdStr)) {
    userList.push(userIdStr)
    writeJsonFile(groupUserListPath, userList)
  }
}

export function saveUserScheduleData(userId, groupId, courseSchedule) {
  const userIdStr = String(userId)
  writeJsonFile(getUserSchedulePath(userIdStr), courseSchedule)

  const cacheKey = getUserScheduleCacheKey(userIdStr)
  userScheduleCache.set(cacheKey, courseSchedule)

  if (groupId) {
    addUserToGroupList(groupId, userIdStr)
  }
}

export function listUsersWithScheduleFromFiles() {
  try {
    if (!fs.existsSync(USER_DATA_DIR)) return []
    return fs.readdirSync(USER_DATA_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(".json", ""))
  } catch (error) {
    logger.error(`[ClassTable] 获取全部课表用户失败: ${error.stack || error}`)
    return []
  }
}

export function getGroupUserIds(groupId) {
  try {
    const groupUserListPath = getGroupUserListPath(groupId)
    if (!fs.existsSync(groupUserListPath)) return []

    const userIds = readJsonFile(groupUserListPath)
    return userIds.filter((userId) => hasUserSchedule(userId))
  } catch (error) {
    logger.error(`[ClassTable] 获取群组用户列表失败: ${error.stack || error}`)
    return []
  }
}

export function syncGroupUserListWithMembers(groupId, memberInfo, e = null) {
  try {
    const memberIds = Array.from(memberInfo.keys()).map(String)
    // 成员缓存里的 id 形态不一定和历史课表文件名一致（裸 openid vs 带实例前缀），
    // 命中哪一种就按哪一种落盘，避免同一个人的课表从群列表里凭空消失
    const validUserIds = [...new Set(
      memberIds
        .map((userId) => resolveStoredUserId(userId, userIdCandidates(e, userId)))
        .filter(Boolean)
    )]
    writeJsonFile(getGroupUserListPath(groupId), validUserIds)
    return validUserIds
  } catch (error) {
    logger.error(`[ClassTable] 同步群组用户列表失败: ${error.stack || error}`)
    return []
  }
}
