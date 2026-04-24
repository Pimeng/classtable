import path from "node:path"
import puppeteer from "../../../lib/puppeteer/puppeteer.js"
import config from "./config.js"

/**
 * 渲染图片
 * @param pluginName 插件名称
 * @param tplName 模板名称
 * @param data 渲染数据
 * @param e Event
 */
export async function renderImg(pluginName, tplName, data, e) {
  try {
    const botName = await getBotName(e, 'Bot')
    const pluginResources = `./plugins/${pluginName}/resources`
    const tplFile = `${pluginResources}/html/${tplName}.art`
    const _res_path = path.join(process.cwd(), 'plugins', pluginName, 'resources')

    const base64 = await puppeteer.screenshot(pluginName, {
      saveId: tplName,
      imgType: 'png',
      tplFile,
      pluginResources,
      _res_path,
      botName,
      ...data
    })

    if (base64) {
      await e.reply(base64)
      return true
    }
    return false
  } catch (error) {
    logger.error(`[ClassTable] 渲染图片失败: ${error}`)
    return false
  }
}

/**
 * 发送 JSON POST 请求
 * @param {string} url 请求地址
 * @param {object} data 请求体
 * @param {number} timeout 超时时间(ms)
 * @returns {Promise<any>}
 */
export async function postJson(url, data, timeout = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function getBotName(e, fallback = null) {
  return config.BOT_NAME || Bot[e.self_id || Bot.uin]?.nickname || Bot.nickname || fallback || null
}

/**
 * 保守尝试撤回事件消息，避免权限不足导致异常
 * @param {Object} e Event
 * @param {object} options 可选参数
 * @param {number} options.maxAgeSeconds 最大消息年龄(秒)，超过则不撤回；0 表示不校验
 * @returns {Promise<boolean>}
 */
export async function safeRecallEventMsg(e, { maxAgeSeconds = 110 } = {}) {
  if (!e?.isGroup) return false

  const botCanManageGroupMsg = !!(e.group?.is_owner || e.group?.is_admin)
  if (!botCanManageGroupMsg) {
    logger.debug?.(`[ClassTable] 跳过撤回：Bot 在群 ${e.group_id} 非管理员/群主`)
    return false
  }

  const msgTime = Number(e.time || e.msgTime || 0)
  if (maxAgeSeconds > 0 && msgTime > 0) {
    const now = Math.floor(Date.now() / 1000)
    if (now - msgTime > maxAgeSeconds) {
      logger.debug?.(`[ClassTable] 跳过撤回：消息已超过安全撤回窗口，group=${e.group_id}, message_id=${e.message_id}`)
      return false
    }
  }

  try {
    await e.recall()
    return true
  } catch (error) {
    logger.warn(`[ClassTable] 尝试撤回消息失败: ${error.stack || error}`)
    return false
  }
}
