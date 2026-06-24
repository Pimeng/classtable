import plugin from "../../../lib/plugins/plugin.js"
import { exec } from "node:child_process"
import { promisify } from "node:util"
import config from "../utils/config.js"

const execAsync = promisify(exec)

const PLUGIN_DIR = "./plugins/classtable"
const REPO_URL = "https://github.com/Pimeng/classtable.git"

let updateStatus = false

export class classtableUpdate extends plugin {
  constructor() {
    super({
      name: "classtable:更新",
      dsc: "课表插件更新",
      event: "message",
      priority: 500,
      rule: [
        {
          reg: "^#?(?:ct|课表插件|classtable)(?:强制|镜像){0,2}更新$",
          fnc: "updatePlugin"
        }
      ]
    })
  }

  async updatePlugin(e) {
    if (!e.isMaster) {
      await e.reply("暂无权限，只有主人才能操作喵")
      return true
    }

    if (updateStatus) {
      await e.reply("[ClassTable] 操作太频繁啦，稍等一下再试")
      return true
    }

    updateStatus = true
    try {
      const isMirror = e.msg.includes("镜像")
      const isForce = e.msg.includes("强制")
      const mirrorPrefix = this.getMirrorPrefix()

      const oldCommitId = await getCommitId()
      const branch = await getCurrentBranch()

      const sourceUrl = isMirror ? `${mirrorPrefix}${REPO_URL}` : REPO_URL
      await e.reply(`[ClassTable] 正在执行${isMirror ? "镜像" : "普通"}${isForce ? "强制" : ""}更新，请稍等`)

      if (isForce) {
        await run(`git -C ${PLUGIN_DIR} checkout .`)
      }

      const pullResult = await run(`git -C ${PLUGIN_DIR} pull --no-rebase ${sourceUrl} ${branch}`)
      await this.installDependencies()

      const pullOutput = `${pullResult.stdout || ""}\n${pullResult.stderr || ""}`.trim()
      const lastUpdateTime = await getLastUpdateTime()

      if (/(Already up[ -]to[ -]date|已经是最新的)/i.test(pullOutput)) {
        await e.reply(`[ClassTable] 已经是最新版本了喵\n最后更新时间：${lastUpdateTime}`)
        return true
      }

      await e.reply(`[ClassTable] 更新成功喵\n最后更新时间：${lastUpdateTime}`)

      const logs = await getUpdateLog(oldCommitId)
      if (logs.length > 0) {
        await this.replyLogs(e, logs)
      }

      await e.reply("请重启 Yunzai 以应用更新哦喵\n【#重启】")
      return true
    } catch (err) {
      logger.error(`[ClassTable] 更新失败: ${err}`)
      await this.replyUpdateError(e, err)
      return true
    } finally {
      updateStatus = false
    }
  }

  getMirrorPrefix() {
    const configured = String(config.UPDATE_MIRROR_URL || "").trim()
    if (!configured) return "https://ghproxy.net/"
    return configured.endsWith("/") ? configured : `${configured}/`
  }

  async installDependencies() {
    try {
      await run(`pnpm -C ${PLUGIN_DIR} i --registry=https://registry.npmmirror.com`)
      return
    } catch (pnpmErr) {
      logger.warn(`[ClassTable] pnpm 安装依赖失败，将尝试 npm: ${pnpmErr}`)
    }

    await run(`npm --prefix ${PLUGIN_DIR} i --registry=https://registry.npmmirror.com`)
  }

  async replyLogs(e, logs) {
    const msgList = logs.map((line) => ({
      user_id: Bot.uin,
      nickname: Bot.nickname,
      message: line
    }))

    let forwardMsg = null
    try {
      if (e.isGroup && e.group?.makeForwardMsg) {
        forwardMsg = await e.group.makeForwardMsg(msgList)
      } else if (e.friend?.makeForwardMsg) {
        forwardMsg = await e.friend.makeForwardMsg(msgList)
      }
    } catch (err) {
      logger.warn(`[ClassTable] 生成转发消息失败: ${err}`)
    }

    if (forwardMsg) {
      await e.reply(forwardMsg)
      return
    }

    await e.reply(logs.join("\n"))
  }

  async replyUpdateError(e, err) {
    const errMsg = String(err?.message || err || "")

    if (errMsg.includes("Timed out")) {
      await e.reply("[ClassTable] 更新失败：连接超时")
      return
    }

    if (/Failed to connect|unable to access/i.test(errMsg)) {
      await e.reply("[ClassTable] 更新失败：连接失败")
      return
    }

    if (errMsg.includes("be overwritten by merge") || errMsg.includes("CONFLICT")) {
      await e.reply("[ClassTable] 更新失败：存在冲突，请解决后重试，或使用“强制更新”放弃本地修改")
      return
    }

    await e.reply(`[ClassTable] 更新失败：${errMsg}`)
  }
}

async function run(command) {
  try {
    const result = await execAsync(command, { windowsHide: true })
    return { ...result, command }
  } catch (err) {
    const errorText = [err?.message, err?.stdout, err?.stderr].filter(Boolean).join("\n")
    throw new Error(errorText || String(err))
  }
}

async function getCommitId() {
  const { stdout } = await run(`git -C ${PLUGIN_DIR} rev-parse --short HEAD`)
  return String(stdout || "").trim()
}

async function getCurrentBranch() {
  const { stdout } = await run(`git -C ${PLUGIN_DIR} rev-parse --abbrev-ref HEAD`)
  return String(stdout || "").trim() || "main"
}

async function getUpdateLog(oldCommitId) {
  const { stdout } = await run(
    `git -C ${PLUGIN_DIR} log -20 --oneline --pretty=format:"%h||[%cd]  %s" --date=format:"%m-%d %H:%M"`
  )

  const rows = String(stdout || "").split("\n").filter(Boolean)
  const logs = []
  for (const row of rows) {
    const [commitId, content] = row.split("||")
    if (!commitId || !content) continue
    if (commitId.trim() === oldCommitId) break
    if (content.includes("Merge branch")) continue
    logs.push(content.trim())
  }

  if (logs.length > 0) {
    logs.push("更多提交记录：")
    logs.push("GitHub: https://github.com/Pimeng/classtable/commits/main")
  }
  return logs
}

async function getLastUpdateTime() {
  try {
    const { stdout } = await run(
      `git -C ${PLUGIN_DIR} log -1 --oneline --pretty=format:"%cd" --date=format:"%m-%d %H:%M"`
    )
    return String(stdout || "").trim() || "获取时间失败"
  } catch (err) {
    logger.warn(`[ClassTable] 获取更新时间失败: ${err}`)
    return "获取时间失败"
  }
}
