import path from "node:path"
import fs from "node:fs"
import YAML from "yaml"
import { fileURLToPath } from "node:url"
import { getClasstableConfig, initClasstableConfig } from "./utils/config.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const CONFIG_DIR = path.join(__dirname, "config")
const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, "config_default.yaml")
const USER_CONFIG_PATH = path.join(CONFIG_DIR, "config.yaml")

function readYaml(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const content = fs.readFileSync(filePath, "utf8")
  return YAML.parse(content) || {}
}

function writeUserConfig(data) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
  fs.writeFileSync(USER_CONFIG_PATH, `${YAML.stringify(data)}`, "utf8")
}

export function supportGuoba() {
  return {
    pluginInfo: {
      name: "classtable",
      title: "课程表插件",
      author: "Pimeng",
      authorLink: "https://github.com/Pimeng",
      link: "https://github.com/Pimeng/classtable",
      isV3: true,
      isV2: false,
      description: "WakeUp 课程表导入与上课状态查询插件",
      icon: "mdi:table-clock",
      iconColor: "#2b90d9"
    },
    configInfo: {
      schemas: [
        {
          component: "SOFT_GROUP_BEGIN",
          label: "WakeUp 分享口令 API"
        },
        {
          field: "WAKEUP_URL",
          label: "WakeUp API 基础地址",
          bottomHelpMessage: "只需填写基础地址，插件会自动拼接 /share?shareCode=xxx",
          component: "Input",
          componentProps: {
            placeholder: "例如: https://wakeup.api.pmnet.work"
          }
        },
        {
          field: "APITOKEN",
          label: "X-Auth-Token",
          bottomHelpMessage: "导入课表时通过请求头 X-Auth-Token 鉴权",
          component: "Input",
          componentProps: {
            placeholder: "请输入 X-Auth-Token"
          }
        },
        {
          component: "SOFT_GROUP_BEGIN",
          label: "功能设置"
        },
        {
          field: "AT_REMIND",
          label: "群聊 @上课提醒",
          bottomHelpMessage: "开启后，在群聊中 @用户会检查其是否在上课",
          component: "Switch"
        },
        {
          field: "BOT_NAME",
          label: "机器人显示名",
          bottomHelpMessage: "留空则使用机器人 QQ 昵称",
          component: "Input",
          componentProps: {
            placeholder: "留空自动使用 QQ 昵称"
          }
        },
        {
          field: "UPDATE_MIRROR_URL",
          label: "GitHub 镜像地址",
          bottomHelpMessage: "留空默认使用 https://ghproxy.net/",
          component: "Input",
          componentProps: {
            placeholder: "例如: https://ghproxy.net/"
          }
        }
      ],
      async getConfigData() {
        return { ...getClasstableConfig() }
      },
      async setConfigData(data, { Result }) {
        try {
          const defaultConfig = readYaml(DEFAULT_CONFIG_PATH)
          const userConfig = readYaml(USER_CONFIG_PATH)
          const nextConfig = { ...defaultConfig, ...userConfig }

          const keys = ["WAKEUP_URL", "APITOKEN", "AT_REMIND", "BOT_NAME", "UPDATE_MIRROR_URL"]
          for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
              nextConfig[key] = data[key]
            }
          }

          writeUserConfig(nextConfig)
          initClasstableConfig()
          logger.mark("[ClassTable] 锅巴更新配置")
          return Result.ok({}, "保存成功，立即生效喵")
        } catch (err) {
          logger.error(`[ClassTable] 锅巴配置保存失败: ${err}`)
          return Result.ok({}, `保存失败: ${err?.message || err}`)
        }
      }
    }
  }
}
