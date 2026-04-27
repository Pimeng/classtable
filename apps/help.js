import plugin from "../../../lib/plugins/plugin.js"
import common from "../../../lib/common/common.js"
import { getBotName } from "../utils/appHelpers.js"

export class classtableHelp extends plugin {
  constructor() {
    super({
      name: "classtable:帮助",
      dsc: "课程表插件帮助",
      event: "message",
      priority: 10,
      rule: [
        {
          reg: "^课表插件帮助$",
          fnc: "showMenu"
        }
      ]
    })
  }

  async showMenu(e) {
    const botName = await getBotName(e, "Bot")
    const msg = ["课程表插件使用帮助"]

    msg.push([
      "导入课表：",
      `1. 发送 WakeUp 完整分享口令给 ${botName}，会自动识别导入。`,
      "2. 发送 `#导入课表` 后再上传 JSON 文件，支持插件标准格式和拾光格式。",
      "3. 如果收到文件名以 `classtable-` 开头的 JSON 文件，直接发送给 Bot 也会自动导入。"
    ].join("\n"))

    msg.push([
      "导出课表：",
      "- `#导出课表`：导出插件标准格式 JSON",
      "- `#导出课表 拾光`：导出拾光格式 JSON",
      "- 群聊中需要再发送 `#确认导出课表`，或用 `#取消导出课表` 终止"
    ].join("\n"))

    msg.push([
      "课表查询：",
      "- `今天课表 / 明天课表 / 后天课表 / 昨天课表`",
      "- `YYYY-MM-DD课表`",
      "- `查课表 YYYY-MM-DD`"
    ].join("\n"))

    msg.push([
      "群内状态：",
      "- `群友在上什么课`：查看当前群友上课状态",
      "- `所有人在上什么课`：查看所有已绑定用户状态"
    ].join("\n"))

    msg.push([
      "翘课功能：",
      "- `什么水课，翘了！` 或 `#clsskip`",
      "- `哎不翘了还是` 或 `#clscancel`"
    ].join("\n"))

    const forwardMsg = await common.makeForwardMsg(e, msg, "课程表插件使用帮助")
    await e.reply(forwardMsg)
  }
}
