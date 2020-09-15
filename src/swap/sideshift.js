// @flow

import { gt, lt, mul } from 'biggystring'
import {
  SwapAboveLimitError,
  SwapBelowLimitError,
  SwapPermissionError
} from 'edge-core-js'
import {
  type EdgeCorePluginOptions,
  type EdgeCurrencyWallet,
  type EdgeFetchResponse,
  type EdgeSpendInfo,
  type EdgeSwapInfo,
  type EdgeSwapPlugin,
  type EdgeSwapQuote,
  type EdgeSwapRequest,
  type EdgeTransaction,
  SwapCurrencyError
} from 'edge-core-js/types'

import { makeSwapPluginQuote } from '../swap-helpers.js'

// Invalid currency codes should *not* have transcribed codes
// because currency codes with transcribed versions are NOT invalid
const CURRENCY_CODE_TRANSCRIPTION = {
  // Edge currencyCode: exchangeCurrencyCode
  USDT: 'usdtErc20'
}

const pluginId = 'sideShift'
const swapInfo: EdgeSwapInfo = {
  pluginId,
  displayName: 'SideShift.ai',
  supportEmail: 'help@sideshift.ai'
}
type FixedQuote = {
  createdAt: string,
  depositAmount: string,
  depositMethod: string,
  expiresAt: string,
  id: string,
  rate: string,
  settleAmount: string,
  settleMethod: string
}

type FixedQuoteRequestParams = {
  depositMethod: string,
  settleMethod: string,
  depositAmount: string
}

type OrderRequest = {
  createdAt: string,
  createdAtISO: Date,
  expiresAt: string,
  expiresAtIso: Date,
  depositAddress: {
    address: string
  },
  depositMethod: string,
  id: string,
  orderId: string,
  settleAddress: {
    address: string
  },
  settleMethod: string,
  depositMax: string,
  depositMin: string,
  quoteId: string,
  settleAmount: string,
  depositAmount: string,
  deposits: Array<any>
}

type OrderRequestParams = {
  type: string,
  quoteId: string,
  affiliateId: string,
  sessionSecret?: string,
  settleAddress: string
}

type Rate = {
  rate: number,
  min: string,
  max: string,
  error?: {
    message: string
  }
}

type Permission = {
  createOrder: boolean,
  createQuote: boolean
}

const dontUseLegacy = {}

async function getAddress(
  wallet: EdgeCurrencyWallet,
  currencyCode: string
): Promise<string> {
  const addressInfo = await wallet.getReceiveAddress({ currencyCode })
  return addressInfo.legacyAddress && !dontUseLegacy[currencyCode]
    ? addressInfo.legacyAddress
    : addressInfo.publicAddress
}

async function checkReplyForError(reply: EdgeFetchResponse): Promise<any> {
  let replyJson
  try {
    replyJson = await reply.json()
  } catch (e) {
    throw new Error(`SideShift.ai returned error code ${reply.status}`)
  }

  return replyJson
}

async function checkRateForError(
  rate: Rate,
  request: EdgeSwapRequest,
  depositAmount: string,
  log
): Promise<any> {
  if (rate.error) {
    throw new SwapCurrencyError(
      swapInfo,
      request.fromCurrencyCode,
      request.toCurrencyCode
    )
  }

  const multiplier = request.fromWallet.currencyInfo.denominations.find(
    d => d.name === request.fromCurrencyCode
  )
    ? request.fromWallet.currencyInfo.denominations.find(
        d => d.name === request.fromCurrencyCode
      ).multiplier
    : request.fromWallet.currencyInfo.metaTokens
        .find(t => t.currencyCode === request.fromCurrencyCode)
        .denominations.find(d => d.name === request.fromCurrencyCode).multiplier

  log('multiplier', multiplier)

  const nativeDepositAmount = mul(depositAmount, multiplier)

  log('nativeDeposit', nativeDepositAmount)

  const amount =
    request.quoteFor === 'from' ? request.nativeAmount : nativeDepositAmount

  log('amount', amount)
  const nativeMin = await request.fromWallet.denominationToNative(
    rate.min,
    request.fromCurrencyCode
  )

  const nativeMax = await request.fromWallet.denominationToNative(
    rate.max,
    request.fromCurrencyCode
  )

  if (lt(amount, nativeMin)) {
    throw new SwapBelowLimitError(swapInfo, nativeMin)
  }

  if (gt(amount, nativeMax)) {
    throw new SwapAboveLimitError(swapInfo, nativeMax)
  }
}

export function makeSideShiftPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { io, initOptions, log } = opts
  const baseUrl = 'https://sideshift.ai/api/v1/'

  async function get(path: string): Promise<any> {
    const url = `${baseUrl}${path}`
    const reply = await io.fetchCors(url)
    return checkReplyForError(reply)
  }

  async function post(path, body): Promise<any> {
    const url = `${baseUrl}${path}`
    const reply = await io.fetchCors(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    return checkReplyForError(reply)
  }

  const out: EdgeSwapPlugin = {
    swapInfo,
    async fetchSwapQuote(request: EdgeSwapRequest): Promise<EdgeSwapQuote> {
      const permission: Permission = await get('permissions')
      log('request', request)
      if (
        permission.createOrder === false ||
        permission.createQuote === false
      ) {
        throw new SwapPermissionError(swapInfo, 'geoRestriction')
      }

      const [depositAddress, settleAddress] = await Promise.all([
        getAddress(request.fromWallet, request.fromCurrencyCode),
        getAddress(request.toWallet, request.toCurrencyCode)
      ])

      let safeFromCurrencyCode = request.fromCurrencyCode.toLowerCase()
      let safeToCurrencyCode = request.toCurrencyCode.toLowerCase()
      if (CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]) {
        safeFromCurrencyCode =
          CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]
      }
      if (CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]) {
        safeToCurrencyCode = CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]
      }

      const rate: Rate = await get(
        `pairs/${safeFromCurrencyCode}/${safeToCurrencyCode}`
      )

      const quoteAmount =
        request.quoteFor === 'from'
          ? await request.fromWallet.nativeToDenomination(
              request.nativeAmount,
              request.fromCurrencyCode
            )
          : await request.toWallet.nativeToDenomination(
              request.nativeAmount,
              request.toCurrencyCode
            )

      log('quoteAmount', quoteAmount)

      const depositAmount =
        request.quoteFor === 'from'
          ? quoteAmount
          : (parseFloat(quoteAmount) / rate.rate).toFixed(8).toString()

      log('depositAmount', depositAmount)

      await checkRateForError(rate, request, depositAmount, log)

      const fixedRateQuoteParams: FixedQuoteRequestParams = {
        depositMethod: safeFromCurrencyCode,
        settleMethod: safeToCurrencyCode,
        depositAmount
      }

      const fixedRateQuote: FixedQuote = await post(
        'quotes',
        fixedRateQuoteParams
      )

      const orderRequestParams: OrderRequestParams = {
        type: 'fixed',
        quoteId: fixedRateQuote.id,
        affiliateId: initOptions.affiliateId,
        settleAddress
      }

      const quoteInfo: OrderRequest = await post('orders', orderRequestParams)

      const spendInfoAmount = await request.fromWallet.denominationToNative(
        quoteInfo.depositAmount,
        request.fromCurrencyCode.toUpperCase()
      )

      const amountExpectedFromNative = await request.fromWallet.denominationToNative(
        quoteInfo.depositAmount,
        request.fromCurrencyCode
      )

      const amountExpectedToNative = await request.fromWallet.denominationToNative(
        quoteInfo.settleAmount,
        request.toCurrencyCode
      )

      const spendInfo: EdgeSpendInfo = {
        currencyCode: request.fromCurrencyCode,
        spendTargets: [
          {
            nativeAmount: spendInfoAmount,
            publicAddress: quoteInfo.depositAddress.address
          }
        ],
        networkFeeOption:
          request.fromCurrencyCode.toUpperCase() === 'BTC'
            ? 'high'
            : 'standard',
        swapData: {
          orderId: quoteInfo.orderId,
          isEstimate: false,
          payoutAddress: settleAddress,
          payoutCurrencyCode: safeToCurrencyCode,
          payoutNativeAmount: amountExpectedToNative,
          payoutWalletId: request.toWallet.id,
          plugin: { ...swapInfo },
          refundAddress: depositAddress
        }
      }
      const tx: EdgeTransaction = await request.fromWallet.makeSpend(spendInfo)

      return makeSwapPluginQuote(
        request,
        amountExpectedFromNative,
        amountExpectedToNative,
        tx,
        settleAddress,
        pluginId,
        false,
        quoteInfo.expiresAtIso,
        quoteInfo.id
      )
    }
  }

  return out
}
