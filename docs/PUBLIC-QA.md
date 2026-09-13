# 公开前 QA 记录

日期：2026-09-13。范围仅为本脱敏求职展示副本；未修改客户原项目，未连接生产系统，未创建 remote，未 push。

## 结论

可作为脱敏求职作品仓库公开，必须保留 README 中的已知依赖风险说明；不宣称 audit 全绿或已通过全面生产安全审计。本轮没有代替用户提交或发布。

## 代码与回归

- 6 个页面/组件共 9 处 `Space direction` 改为 `orientation`，布局方向不变。
- 工作台账号弹窗和删除确认弹窗使用 `mask.closable`，关闭策略不变。
- 业务配置欢迎语只在表单挂载后回填，避免开发模式 useForm 未连接提示。
- 隐藏父目录下，原 `sendFile(绝对路径)` 会把父目录误算入 dotfile 检查；改为在已验证的 realpath 根目录内发送相对路径，继续拒绝隐藏文件并保留用户鉴权、原路径及真实路径越界检查。
- 测试服务启动等待由约 10 秒调整为最多 60 秒，进程提前退出仍立即失败，没有删除或屏蔽业务断言/Console 错误。
- 最终代码的 lint、typecheck、build、业务 smoke、密码/旧 token 安全专项、多人员预分配专项通过。多人专项 10 项、账号专项 7 项；Console 零错误断言通过。

## README 首次安装验证

使用不含 node_modules、dist、真实环境文件、上传文件和 Git 历史的干净副本，另建独立空 MySQL 数据卷。只通过安全示例生成新的本地配置。QA 用非默认本机 MySQL 端口和容器名避免冲突，未改其他数据库。

逐项执行：

1. `npm ci`。
2. `npm run demo:setup`。
3. `npm run db:start`、`npm run db:status`，确认 healthy。
4. `npm run db:generate`、`npm run db:migrate`、`npm run db:seed`；9 个 migration、7 个虚构演示订单。
5. `npm run dev:server` 和 `npm run dev:client` 分开启动。
6. `npm run dev` 组合启动。
7. `npm run build` 和 `npm run demo:start`，运行真实编译产物。
8. `npm run lint`、`npm run typecheck`、`npm run test:calendar`、`npm run test:smoke`、`npx playwright install chromium`、`npm run test:security`、`npm run test:collaboration`。
9. README 的手动 MySQL SQL 块在另一套网络隔离的空 MySQL 8.4 中执行，两个数据库和 localhost 应用账号创建成功。密码占位符替换为本次临时生成值，未记录其内容。

三种应用启动方式均验证管理端登录、订单/权限/配置/财务页面、390px 员工登录。Console 零错误；原手册截图未重新截图或替换。当前电脑模拟首次安装，不代表已覆盖所有 Windows/Linux/macOS 配置。

## Audit 定位

升级前：

```text
@prisma/client@6.19.0 --peer--> prisma@6.19.0
prisma@6.19.0
└── @prisma/config@6.19.0
    ├── effect@3.18.4       受影响 <3.20.0
    └── deepmerge-ts@7.1.5  受影响 <8.0.0
```

升级后：

```text
@prisma/client@6.19.3 --peer--> prisma@6.19.3
prisma@6.19.3
└── @prisma/config@6.19.3
    ├── effect@3.21.0       原漏洞已修复
    └── deepmerge-ts@7.1.5  保留已知风险
```

完整 audit：4 high → 3 high，0 critical；omit-dev audit：仍为 3 high。保留的三项名称为 prisma、@prisma/config、deepmerge-ts，来自同一个底层递归合并漏洞。

升级遵循 [Prisma 6.19.3 官方安全补丁](https://github.com/prisma/orm/releases/tag/6.19.3)。[Effect 官方公告](https://github.com/Effect-TS/effect/security/advisories/GHSA-38f7-945m-qr2g) 涉及 RPC 并发上下文，修复版本从 3.20.0 起。

[DeepmergeTS 官方公告](https://github.com/RebeccaStevens/deepmerge-ts/security/advisories/GHSA-ggr8-5vv4-36mx) 涉及循环对象导致栈耗尽，普通 JSON 自身无法表达这种自引用对象。[8.0.0 发布说明](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0) 明确有 Map 合并、类型和输入修改行为的破坏性变化，因此本轮没有强制覆盖 Prisma 固定依赖。包源码显示其调用位于 Prisma 配置读取；当前业务代码未直接引入这两个底层库，这仅是可达性分析，不能替代漏洞修复。

建议等待 Prisma 6 兼容补丁；如必须清零，应独立评估上游版本/驱动/配置兼容性，并重复空库 migration、seed、完整回归。不要把 npm 建议的强制降级/跨版本覆盖当安全补丁直接执行。

## 公开内容审查

- 原始 140 个暂存文件逐文件检查 Git blob，而非仅扫描工作目录；本轮新增 `.gitattributes` 和本记录，最终共 142 个文件，均纳入复查。
- 检查客户名称、品牌、联系方式、身份证、生产域名/IP、备案信息、SSH 私钥、JWT 字面值、机器私有路径、数据库连接凭据和密码字符串。
- 代码中的 passwordHash/JWT_SECRET 等标识符、示例占位符、错误认证测试字符串和公开虚构 seed 密码属于功能/测试材料；没有把这些关键词误报为真实客户凭据。
- `.gitignore` 增加环境文件变体、数据库文件、备份归档、凭据和原始截图拦截；截图只允许已审阅的 5 个文件与说明，测试 PNG 仅允许既有夹具。20 个正反向 ignore 用例通过。
- 5 张截图为虚构数据；PNG 完整性、尺寸和元数据检查通过，无 EXIF/文本元数据。没有引入原客户截图或附件。
- Git 只保留新的本地索引，无客户原 Git 历史、无 remote；未提交运行密钥、测试输出、数据库或上传文件。
- `.gitattributes` 统一文本检出换行符为 LF，避免 Linux 初始化脚本带入 Windows CRLF；图片按二进制处理；只清理 9 处既有文件末尾空行，`git diff --cached --check` 通过。

## 建议首次提交说明

`feat: add sanitized club management portfolio showcase`

此文件只记录验证；不代表已 commit、push 或创建远程仓库。
