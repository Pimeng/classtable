import plugin from "../../../lib/plugins/plugin.js"
import {
  getMultipleNextClassRenderData,
  getAllUsersNextClassRenderData
} from "../utils/renderNextClass.js"
import { renderImg } from "../utils/appHelpers.js"

export class classtableStatus extends plugin {
  constructor() {
    super({
      name: 'classtable:查询状态',
      dsc: '查询群友或所有人上课状态',
      event: 'message',
      priority: 10,
      rule: [
        {
          reg: '^所有群友在上什么课$',
          fnc: 'showAllGroupNextClass'
        },
        {
          reg: '^(群友在上什么课|#?clstb)$',
          fnc: 'showGroupNextClass'
        },
        {
          reg: '^所有人在上什么课$',
          fnc: 'showAllNextClass'
        }
      ]
    })
  }

  async showAllGroupNextClass(e) {
    try {
      const renderData = await getMultipleNextClassRenderData(e)
      await renderImg('classtable', 'next_class', renderData, e)
    } catch (error) {
      logger.error(`[ClassTable] 显示群组下一节课失败: ${error}`)
      await e.reply("获取群课表信息时发生错误")
    }
  }

  async showGroupNextClass(e) {
    try {
      const renderData = await getMultipleNextClassRenderData(e, 10)
      await renderImg('classtable', 'next_class', renderData, e)
    } catch (error) {
      logger.error(`[ClassTable] 显示群组下一节课失败: ${error}`)
      await e.reply("获取群课表信息时发生错误")
    }
  }

  async showAllNextClass(e) {
    if (!e.isMaster) {
      return await e.reply("你暂时无权限看哦（")
    }
    try {
      const renderData = await getAllUsersNextClassRenderData(e)
      await renderImg('classtable', 'next_class', renderData, e)
    } catch (error) {
      logger.error(`[ClassTable] 显示所有人下一节课失败: ${error}`)
      await e.reply("获取所有人的课表信息时发生错误")
    }
  }
}
