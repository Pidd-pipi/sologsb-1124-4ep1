/**
 * 拍卖台账（Auction Ledger）数据模型。
 *
 * 把征集清单（标的）、意向报价（含预算占用）、落槌结果与到货登记接成同一套账。
 * 所有数据落在本地 IndexedDB：现场断网时照常登记并写入 outbox 队列，
 * 回馆联网后逐条合并，终局结果（已落槌/已取消/已到货）不会被后到记录覆盖。
 */

/** 标的品类：邮戳 或 实寄封（也兼容其它邮品） */
export type LotCategory = 'postmark' | 'cover' | 'other'

export const LOT_CATEGORY_LABEL: Record<LotCategory, string> = {
  postmark: '邮戳',
  cover: '实寄封',
  other: '其它邮品'
}

/** 征集清单上的标的 */
export interface AuctionLot {
  id?: number
  /** 业务唯一键（跨会场合并去重用） */
  uid: string
  /** 拍品编号，如 L-2026-001 */
  lotNo: string
  title: string
  category: LotCategory
  /** 征集估价区间 */
  estimateLow: number
  estimateHigh: number
  note: string
  createdAt: string
  updatedAt: string
}

/** 会场（预算与最高报价各会场独立计算） */
export interface AuctionVenue {
  id?: number
  uid: string
  name: string
  /** 本场意向预算总额（元）；占用 = 在拍意向额 + 应付未付 */
  budget: number
  /** 拍卖会日期 YYYY-MM-DD */
  sessionDate: string
  note: string
  createdAt: string
  updatedAt: string
}

/**
 * 报价登记状态：
 * - draft      预算不足或同一件已被别人先报 → 保留的草稿（不占用预算，附差额说明）
 * - active     已登记、在拍，占用意向额
 * - cancelled  竞价取消，释放占用
 * - won        落槌竞得，意向额转为应付
 * - lost       落槌未得，释放占用
 * - rejected   回馆合并时与服务端真相冲突（如落槌后才到的出价），丢弃并说明
 */
export type BidStatus = 'draft' | 'active' | 'cancelled' | 'won' | 'lost' | 'rejected'

export const BID_STATUS_LABEL: Record<BidStatus, string> = {
  draft: '草稿',
  active: '在拍',
  cancelled: '已取消',
  won: '竞得',
  lost: '未得',
  rejected: '合并丢弃'
}

export type BidRejectReason = 'budget_short' | 'outbid' | 'closed_lot' | ''

export const BID_REJECT_REASON_LABEL: Record<Exclude<BidRejectReason, ''>, string> = {
  budget_short: '预算不足',
  outbid: '已被别人先报',
  closed_lot: '该件已终局（落槌/取消）'
}

/** 意向报价登记（同一件在多个会场各算一套：占用与最高报价按 venueId 独立） */
export interface AuctionBid {
  id?: number
  uid: string
  venueId: number
  lotId: number
  /** 出价人：本人登记固定为 'me'；用于判断"同一件被别人先报" */
  bidder: string
  /** 意向价（含佣金口径以登记时为准） */
  amount: number
  status: BidStatus
  /** 草稿/丢弃原因 */
  rejectReason: BidRejectReason
  /** 差额说明：预算缺口 或 与最高报价的差额（元） */
  shortfall: number
  note: string
  /** 登记现场是否处于断网状态 */
  offline: boolean
  createdAt: string
  updatedAt: string
}

/** 落槌结果 */
export interface AuctionResult {
  id?: number
  uid: string
  venueId: number
  lotId: number
  bidId: number | null
  winner: string
  /** 落槌价（元） */
  hammerPrice: number
  /** 买家佣金（元），到货时与落槌价合并成实付 */
  buyerPremium: number
  /** 是否本人竞得（落槌结果与本人出价冲突时以此为准） */
  won: boolean
  /** 回馆合并冲突时不覆盖真相，只在备注留痕 */
  conflictNote: string
  offline: boolean
  createdAt: string
}

/** 到货状态 */
export type ArrivalStatus = 'pending' | 'received' | 'abnormal'

export const ARRIVAL_STATUS_LABEL: Record<ArrivalStatus, string> = {
  pending: '待到货',
  received: '正常到货',
  abnormal: '到货异常'
}

/** 到货登记（一件竞得拍品对应一条；到货异常重算占用/应付） */
export interface AuctionArrival {
  id?: number
  uid: string
  venueId: number
  lotId: number
  resultId: number
  status: ArrivalStatus
  arrivedAt: string
  /** 异常扣款（缺损折让、违约扣款等，元） */
  adjustment: number
  /** 实付 = 落槌价 + 佣金 - 异常折让 */
  settledAmount: number
  note: string
  offline: boolean
  createdAt: string
  updatedAt: string
}

/** outbox 操作类型 */
export type OpType = 'bid' | 'cancel' | 'result' | 'arrival'

export const OP_TYPE_LABEL: Record<OpType, string> = {
  bid: '意向登记',
  cancel: '取消竞价',
  result: '落槌结果',
  arrival: '到货登记'
}

/** outbox 合并状态 */
export type OpStatus = 'queued' | 'applied' | 'conflict' | 'retry' | 'dead'

export const OP_STATUS_LABEL: Record<OpStatus, string> = {
  queued: '待合并',
  applied: '已合并',
  conflict: '冲突待处理',
  retry: '写库失败待重试',
  dead: '已放弃'
}

interface OpBase<T extends OpType = OpType> {
  opId: string
  type: T
  venueId: number
  lotId: number
  /** 现场操作发生时间（决定回放顺序） */
  occurredAt: string
}

export interface BidOpPayload extends OpBase<'bid'> {
  bidUid: string
  amount: number
  note: string
}

export interface CancelOpPayload extends OpBase<'cancel'> {
  bidUid: string
  note: string
}

export interface ResultOpPayload extends OpBase<'result'> {
  resultUid: string
  winner: string
  hammerPrice: number
  buyerPremium: number
  won: boolean
}

export interface ArrivalOpPayload extends OpBase<'arrival'> {
  arrivalUid: string
  resultUid: string
  arrivedAt: string
  adjustment: number
  status: ArrivalStatus
  note: string
}

/** 断网操作的业务负载（四种之一） */
export type AuctionOpPayload =
  | BidOpPayload
  | CancelOpPayload
  | ResultOpPayload
  | ArrivalOpPayload

/** 队列记录字段 */
export interface AuctionOpRecord {
  id?: number
  /** 合并状态（注意避免与 ArrivalOpPayload.status 同名交叉成 never） */
  opStatus: OpStatus
  /** 合并时产生的说明（冲突原因 / 失败原因） */
  message: string
  attempts: number
  createdAt: string
  updatedAt: string
}

type WithRecord<T> = T & AuctionOpRecord

/** 断网期间积压、回馆后需合并的操作（显式逐成员联合，保证判别收窄） */
export type AuctionOp =
  | WithRecord<BidOpPayload>
  | WithRecord<CancelOpPayload>
  | WithRecord<ResultOpPayload>
  | WithRecord<ArrivalOpPayload>

/** 操作流水：所有写操作（线上线下）统一审计轨迹 */
export interface AuctionJournal {
  id?: number
  opId: string
  type: OpType
  venueId: number
  lotId: number
  action: string
  detail: string
  offline: boolean
  createdAt: string
}

/* ------------------------------ 表单 / 服务入参 ------------------------------ */

/** 落槌结果登记入参 */
export interface ResultInput {
  venueId: number
  lotId: number
  winner: string
  hammerPrice: number
  buyerPremium: number
  won: boolean
  offline: boolean
  opId?: string
  resultUid?: string
  note?: string
}

/** 到货登记入参 */
export interface ArrivalInput {
  venueId: number
  lotId: number
  arrivedAt: string
  /** 异常折让/扣款（元），正常到货填 0 */
  adjustment: number
  status: ArrivalStatus
  note: string
  offline: boolean
  opId?: string
  arrivalUid?: string
}

export function createEmptyLot(now: string): AuctionLot {
  return {
    uid: '',
    lotNo: '',
    title: '',
    category: 'other',
    estimateLow: 0,
    estimateHigh: 0,
    note: '',
    createdAt: now,
    updatedAt: now
  }
}

export function createEmptyVenue(now: string): AuctionVenue {
  return {
    uid: '',
    name: '',
    budget: 0,
    sessionDate: now.slice(0, 10),
    note: '',
    createdAt: now,
    updatedAt: now
  }
}
