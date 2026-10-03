# 邮戳与实寄封编目台（gbpostmark）

面向邮品收藏者与邮政史研究者：为邮戳、邮路和实寄封建编目，记录戳型、使用年代、邮路节点与封上票戳组合，并以时间轴还原一封邮件的实际寄递过程；另设**拍卖征集账**，把征集清单、现场报价与回馆到货接成同一套账，支持拍卖会现场断网登记、回馆合并。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21824>

停止（保留镜像）：

```bash
docker compose down
```

> 若 21824 端口被占用，修改 `.env` 中的 `FRONTEND_PORT` 后重新执行上面两条命令即可。

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + 组合式 API） |
| 语言 | TypeScript（`strict`，构建时 `vue-tsc` 类型检查零错误） |
| 构建 | Vite 6 |
| UI | Element Plus + `@element-plus/icons-vue` |
| 状态 | Pinia（`postmarkStore` / `coverStore` / `routeStore`） |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 本地数据 | IndexedDB（Dexie，含版本号与升级迁移）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（gzip + SPA 回退） |

## 三、核心数据模型

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| Postmark 邮戳 | `frontend/src/types/postmark.ts` | 编目号、戳型、局所、省份、使用年代、戳面日期、墨色、戳径、戳面文字、中英双文字、稀见度、戳样图、备注 |
| Cover 实寄封 | `frontend/src/types/cover.ts` | 封号、寄出/收件地、寄出/到达日期、贴票构成、关联邮戳、邮路、中转地、给据、品相、来源、购入价、藏册页位 |
| PostalRoute 邮路 | `frontend/src/types/route.ts` | 邮路号、名称、时期、运输方式、节点数组（局所/到达日期/中转戳）、全程天数、班期、备注 |
| StamplessEntry 票戳组合 | `frontend/src/types/stampentry.ts` | 所属封、邮票名称、面值、发行年份、齿度、变体、封上位置 |

另有 `frontend/src/types/asset.ts`：戳样与封的正反面原图在 IndexedDB 中**单独建表**（`assets`）。

## 四、页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/` | 重定向到 `/postmarks` | — |
| `/postmarks` | 邮戳目录（按戳型、局所、年代区间筛选，图片墙 ↔ 列表切换） | Postmark |
| `/covers` | 实寄封目录（按收寄地、年代、品相、是否给据筛选，行内显示贴票枚数与关联邮戳数） | Cover |
| `/covers/:id` | 实寄封详情（正反面图、票戳组合表、寄递事实时间轴） | Cover、StamplessEntry、PostalRoute |
| `/routes/:id` | 邮路编辑器（节点拖拽排序、增删中转地、按节点日期自动算全程天数） | PostalRoute |
| `/search` | 综合检索（跨三类按关键词与年代分组检索） | Postmark、Cover、PostalRoute |
| `/auction` | 拍卖征集账（征集清单、线上报价/取消、落槌、到货登记；预算占用面板） | AuctionLot、AuctionBid、AuctionArrival |
| `/auction/offline` | 断网会场登记（按会场记账、回馆合并、草稿改价重试、写库失败回滚演示） | AuctionJournal + 拍卖三张表 |

## 五、共享组件与 hooks / utils

- 组件：`frontend/src/components/common/` 下的 `StampCard.vue`、`CoverCard.vue`、`RouteTimeline.vue`、`ScarceTag.vue`
- hooks：`frontend/src/hooks/useCatalogFilter.ts`（统一过滤与排序）、`frontend/src/hooks/useCoverRoute.ts`（寄递时间轴与在途天数）
- utils：`frontend/src/utils/db.ts`（Dexie 封装/版本迁移/样例数据）、`frontend/src/utils/dateRange.ts`（年代区间、干支互转、日期先后校验）、`frontend/src/utils/id.ts`（编目号与唯一键）、`frontend/src/utils/draft.ts`（localStorage 草稿）

## 六、本地开发（可选，需要本机 Node 20+）

```bash
cd frontend
npm install
npm run dev          # http://localhost:21824
npm run build        # vue-tsc 类型检查 + vite 构建
```

## 七、目录结构

```
sologsb-1124/
├── docker-compose.yml
├── .env.example / .env
├── README.md
└── frontend/
    ├── Dockerfile          # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf          # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/          # postmark / cover / route / stampentry / asset
        ├── stores/         # postmarkStore / coverStore / routeStore
        ├── components/common/
        ├── hooks/
        ├── pages/
        ├── router/
        ├── utils/
        ├── styles/
        ├── App.vue
        └── main.ts
```

## 八、数据存储说明

- **编目数据**：IndexedDB（Dexie，库名 `gbpostmark`）。表结构含版本号，`version(2)` 会把戳样与封图迁移到独立的 `assets` 表并补齐历史记录缺省字段；首次运行写入样例数据，便于直接查看各页面效果。
- **表单草稿**：localStorage，键名前缀 `gbpostmark:draft:`（邮戳、实寄封、邮路各一份），刷新或误关页面后可恢复，可一键清除。
- **无后端**：不请求任何外部接口，容器无状态，不使用数据库服务与命名卷；清除浏览器站点数据即等于清空数据。

## 九、拍卖征集账（断网工作流）

把**征集清单、报价、到货登记**接成同一套账，账本为 IndexedDB 中的四张表（Dexie `version(3)` 新增）：

| 表 | 说明 |
| --- | --- |
| `auctionLots` | 征集清单：拍品号（跨会场识别同一件）、意向价、己方/他人最高报价、状态（在拍/被压过/已落槌/未得/竞价取消/已到货/到货异常）、落槌价 |
| `auctionBids` | 报价：己方或他人、会场、金额；状态 active / superseded / cancelled / draft |
| `auctionArrivals` | 到货登记：正常到货或异常类型（破损/缺件/错发/存疑）、实收数量 |
| `auctionJournal` | 操作账：每条现场操作一条命令（pending/draft/applied/conflict），带幂等键与发生时间 |
| `auctionMeta` | 单行键值：总预算 |

账规则（纯函数实现于 `src/utils/auctionEngine.ts`，无浏览器依赖可单测）：

1. **每件先占用意向额**：己方报价即占用，且每件只占「最高一套」——新高出价自动把同一件旧的有效出价置为 `superseded` 并释放差额占用；
2. **预算不足 / 被别人先报**：现场登记时保留为**草稿**（`draft`，不占预算），消息里写明差额（如「差额 501 元」），可改价后重试；
3. **多会场各算一套**：断网会场视图只回放本会场待合并操作（征集清单跨会场共享），各会场的预算占用与最高报价独立预览；**回馆合并**时按发生时间把各会场记录重放到同一套账，只保留最高一套占用，合计压超总预算给出 overrun 提醒；
4. **重算占用**：竞价取消释放意向额；落槌后己方拍得按落槌价占用、他人竞得/流拍释放；正常到货结清，**到货异常立即释放成交占用**；
5. **落槌结果不被盖掉**：拍品进入终局（落槌/撤拍/到货）后，断网带回的旧报价、旧落槌记为 `conflict` 并说明，绝不覆盖已入账结果；
6. **写库失败回滚可重试**：合并在单个 Dexie 事务内完成（物料表清空重写 + 操作账置位），任何写库异常（页面上的「模拟写库失败」开关可演示）都整体回滚到操作前，pending 原样保留，按钮重试即可；重试按幂等键去重，不会重复入账。

### 测试

```bash
cd frontend
npm test            # 18 项引擎纯函数测试 + 9 项 store（fake-indexeddb）集成测试
npm run test:engine # 仅引擎：占用/差额草稿/多会场合并/终局锁定/幂等
npm run test:store  # 仅集成：断网登记→失败回滚→合并→草稿重试→落槌/到货
```
