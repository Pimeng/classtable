# ClassTable Plugin

Miao-Yunzai 机器人课程表插件，支持 WakeUp 课程表导入。

## 如何安装？

方法1. Git安装

```bash
git clone --depth=1 https://github.com/Pimeng/classtable.git ./plugins/classtable
```

> 或者使用镜像
> ```bash
> git clone --depth=1 https://ghproxy.net/https://github.com/Pimeng/classtable.git ./plugins/classtable
> ```

克隆完毕后重启 Yunzai 就可以使用了

> 对的没有依赖，放到插件目录就能用（

方法2. 压缩包安装

直接下载压缩包然后解压到插件目录 `./plugins/classtable`（注意重命名为 `classtable`）
在右上方有个绿色的 `Code` 按钮，点击，然后选择 `Download ZIP`

## 功能特性

- 支持查看今日课表
- 支持群聊和私聊使用
- 支持导出课表

## 支持的应用

- Wakeup 课程表（已恢复，接着干来）

> [!CAUTION]
> 傻逼 Wakeup 课程表，你很有意思吗？为了不让别人用你的分享口令导入到其他的工具，你还做了这种傻逼的真实设备校验，你觉得非你不可了，就他妈加这么多广告，深色模式你也他妈的是会员专属，咋的你的AI是付费的啊？是100USD/1K Token吗？还有啊，天天弹窗要我强制更新，不更新就不给我用，你是全家死光光了吗？

- 拾光课程表：https://github.com/XingHeYuZhuan/shiguangschedule

## 使用方法

### 导入课表

#### Wakeup

1. 打开 WakeUp 课程表 APP
2. 点击右上角分享按钮
3. 复制完整的分享口令消息
4. 将分享口令消息发送给机器人（群聊或私聊）
5. 机器人会自动识别并导入课表

#### 拾光课程表

文件导出之后发给Bot即可（
