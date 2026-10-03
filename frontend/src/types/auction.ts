/**
 * 拍卖征集账（Auction Ledger）数据模型。
 *
 * 把三件事接成同一套账：
 * 1. 征集清单（AuctionLot）：看中的邮戳 / 实寄封，录入意向价与总预算；
 * 2. 报价（AuctionBid）：己方或他人在各会场对同一件拍品的出价；
 * 3. 到货登记（AuctionArrival）：拍中后回馆验货，品相 / 数量异常要释放占用。
 *
 * 现场断网时操作先落到操作账（AuctionJournal，见下），回馆再合并，
 * 因此所有写库操作都以「命令（AuctionCommand）」表达，便于重放与重试。
 */

/** 拍品类别：复用编目台已有的两类藏品 */
export type LotCategory = 'postmark' | 'cover'

/**
 * 拍品状态机：
 *   watching  在拍/观望 —— 己方最高意向价占用预算
 *   outbid    被他人压过 —— 仍可加价，按最新己方出价占用
 *   won       己方落槌 —— 占用转「成交占用」
 *   lost      他人落槌 / 流拍 —— 释放占用
 *   cancelled 竞价取消（撤拍）—— 释放占用
 *   arrived   正常到货 —— 占用结清
 *   anomaly   到货异常（破损 / 缺件 / 错发）—— 释放占用待处理
 */
export type LotStatus =
  | 'watching'
  | 'outbid'
  | 'won'
  | 'lost'
  | 'cancelled'
  | 'arrived'
  | 'anomaly'

/** 拍品终局：终局后任何针对它的报价/取消都视为过期操作，不得覆盖结果 */
export const TERMINAL_STATUSES: LotStatus[] = ['lost', 'cancelled', 'arrived', 'anomaly']

/** 占用尚未结清的终局（won 仍占用预算，到货登记后才结清） */
export const HELD_STATUSES: LotStatus[] = ['watching', 'outbid', 'won']

export const LOT_STATUS_LABELS: Record<LotStatus, string> = {
  watching: '在拍',
  outbid: '被压过',
  won: '已落槌',
  lost: '未得',
  cancelled: '竞价取消',
  arrived: '已到货',
  anomaly: '到货异常'
}

/** 落槌结果 */
export type HammerResult = 'won' | 'lost' | 'unsold'

export const HAMMER_RESULT_LABELS: Record<HammerResult, string> = {
  won: '己方拍得',
  lost: '他人竞得',
  unsold: '流拍'
}

/** 到货异常类型 */
export type ArrivalIssue =
  | 'damaged' // 破损 / 品相不符
  | 'missing' // 缺件
  | 'wrong' // 错发
  | 'forged' // 存疑 / 伪品

export const ARRIVAL_ISSUE_LABELS: Record<ArrivalIssue, string> = {
  damaged: '破损 / 品相不符',
  missing: '缺件',
  wrong: '错发',
  forged: '存疑 / 伪品'
}

/** 征集清单：一件拍品一行 */
export interface AuctionLot {
  id?: number
  /** 拍品号，跨会场识别同一件的统一标识，如 AL-0001 */
  lotNo: string
  title: string
  category: LotCategory
  /** 关联编目记录（可空：拍品还未入藏编目） */
  refId: number | null
  /** 征集来源 / 拍卖会名称 */
  source: string
  /** 意向价（自己愿意出的上限，元） */
  ceiling: number
  /** 当前他人最高出价（现场情报，元） */
  competitorHigh: number
  /** 己方对这件的最高有效出价（元） */
  ownHigh: number
  status: LotStatus
  /** 落槌价（元，未落槌为 0） */
  hammerPrice: number
  /** 落槌中标方 */
  winner: string
  /** 落槌时间 */
  hammerAt: string
  note: string
  createdAt: string
  updatedAt: string
}

/** 报价记录：同一件在不同会场可重复登记，各算一套预算占用与最高报价 */
export interface AuctionBid {
  id?: number
  /** 拍品号（AuctionLot.lotNo） */
  lotNo: string
  /** 出价金额（元） */
  amount: number
  /** true = 己方出价；false = 他人出价（现场情报） */
  isOwn: boolean
  /** 会场名，如 上海诚轩 / 北京嘉德 */
  venue: string
  /** 出价时间 YYYY-MM-DD HH:mm */
  bidAt: string
  /**
   * 生命周期：
   *   active      有效
   *   superseded  合并时发现同一件在别的会场已有更高己方出价，本条被替代
   *   cancelled   竞价取消 / 撤拍
   *   draft       预算不足或被别人先报时保留的草稿（不占预算，可改后重试）
   */
  state: 'active' | 'superseded' | 'cancelled' | 'draft'
  /** 保留草稿的原因（预算差额等），供页面直接展示 */
  reason: string
  /** 落槌时是否中标（仅落槌后用于汇总） */
  winning: boolean
  createdAt: string
  updatedAt: string
}

/** 到货登记 */
export interface AuctionArrival {
  id?: number
  lotNo: string
  /** true = 正常到货；false = 到货异常 */
  normal: boolean
  issue: ArrivalIssue | ''
  /** 实收数量（默认 1，缺件时可小于应到） */
  receivedQty: number
  note: string
  arrivedAt: string
  createdAt: string
}

/**
 * 操作账：现场断网期间的每一步操作都先记账，回馆后按序合并。
 * 同一条记录重放（重试）时以 idempotencyKey 幂等去重。
 */
export type JournalStatus = 'pending' | 'draft' | 'applied' | 'conflict'

export interface AuctionJournal {
  id?: number
  /** 幂等键：同会场同操作唯一，重试不重复入账 */
  idempotencyKey: string
  /** 会场名；线上（回馆直连）操作为空串 */
  venue: string
  /** 现场登记时间（断网时也能正确排序） */
  occurredAt: string
  status: JournalStatus
  /** 合并 / 重放结果说明（冲突原因、差额等） */
  resultNote: string
  /** 已应用次数（0 或 1，>1 说明发生过重试） */
  attempts: number
  command: AuctionCommand
  createdAt: string
  updatedAt: string
}

/* ------------------------------ 命令定义 ------------------------------ */

export interface SetBudgetCommand {
  type: 'setBudget'
  amount: number
}

export interface UpsertLotCommand {
  type: 'upsertLot'
  lotNo: string
  title: string
  category: LotCategory
  refId: number | null
  source: string
  ceiling: number
  note: string
}

export interface RegisterBidCommand {
  type: 'registerBid'
  lotNo: string
  amount: number
  isOwn: boolean
  venue: string
  bidAt: string
}

export interface CancelBiddingCommand {
  type: 'cancelBidding'
  lotNo: string
  venue: string
  /** 取消指定的己方报价；为空表示撤销这件在该会场的全部己方出价 */
  bidKey: string
  reason: string
}

export interface HammerCommand {
  type: 'hammer'
  lotNo: string
  result: HammerResult
  /** 落槌价（元） */
  price: number
  /** 中标方记录（己方拍得时可空） */
  winner: string
  hammerAt: string
}

export interface ArriveCommand {
  type: 'arrive'
  lotNo: string
  normal: boolean
  issue: ArrivalIssue | ''
  receivedQty: number
  note: string
  arrivedAt: string
}

export type AuctionCommand =
  | SetBudgetCommand
  | UpsertLotCommand
  | RegisterBidCommand
  | CancelBiddingCommand
  | HammerCommand
  | ArriveCommand

export type CommandType = AuctionCommand['type']

export const COMMAND_TYPE_LABELS: Record<CommandType, string> = {
  setBudget: '调整总预算',
  upsertLot: '征集登记',
  registerBid: '报价登记',
  cancelBidding: '竞价取消',
  hammer: '落槌结果',
  arrive: '到货登记'
}

/** 生成一条空白拍品，供表单初始化。 */
export function createEmptyLot(): AuctionLot {
  const now = new Date().toISOString()
  return {
    lotNo: '',
    title: '',
    category: 'cover',
    refId: null,
    source: '',
    ceiling: 0,
    competitorHigh: 0,
    ownHigh: 0,
    status: 'watching',
    hammerPrice: 0,
    winner: '',
    hammerAt: '',
    note: '',
    createdAt: now,
    updatedAt: now
  }
}

/** 当前时间，精确到分钟，供报价 / 落槌时间选择器使用。 */
export function nowMinute(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`
}
