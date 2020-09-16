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

const pluginId = 'sideshift'
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
  createdAtISO: string,
  expiresAt: string,
  expiresAtISO: string,
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
  try {
    return await reply.json()
  } catch (e) {
    throw new Error(`SideShift.ai returned error code ${reply.status}`)
  }
}

async function checkRateForError(
  rate: Rate,
  request: EdgeSwapRequest,
  depositAmount: string
): Promise<any> {
  const { fromCurrencyCode, toCurrencyCode, fromWallet, nativeAmount } = request
  const { denominations, metaTokens } = fromWallet.currencyInfo
  if (rate.error) {
    throw new SwapCurrencyError(swapInfo, fromCurrencyCode, toCurrencyCode)
  }
  const multiplier = denominations.find(d => d.name === fromCurrencyCode)
    ? denominations.find(d => d.name === fromCurrencyCode).multiplier
    : metaTokens
        .find(t => t.currencyCode === fromCurrencyCode)
        .denominations.find(d => d.name === fromCurrencyCode).multiplier

  const nativeDepositAmount = mul(depositAmount, multiplier)

  const amount =
    request.quoteFor === 'from' ? nativeAmount : nativeDepositAmount

  const nativeMin = await fromWallet.denominationToNative(
    rate.min,
    fromCurrencyCode
  )

  const nativeMax = await fromWallet.denominationToNative(
    rate.max,
    fromCurrencyCode
  )

  if (lt(amount, nativeMin)) {
    throw new SwapBelowLimitError(swapInfo, nativeMin)
  }

  if (gt(amount, nativeMax)) {
    throw new SwapAboveLimitError(swapInfo, nativeMax)
  }
}

export function makeSideshiftPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { io, initOptions } = opts
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

      const depositAmount =
        request.quoteFor === 'from'
          ? quoteAmount
          : (parseFloat(quoteAmount) / rate.rate).toFixed(8).toString()

      await checkRateForError(rate, request, depositAmount)

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

      const orderExpirationMs = 1000 * 60 * 5

      return makeSwapPluginQuote(
        request,
        amountExpectedFromNative,
        amountExpectedToNative,
        tx,
        settleAddress,
        pluginId,
        false,
        new Date(Number(quoteInfo.expiresAt) + orderExpirationMs),
        quoteInfo.id
      )
    }
  }

  return out
}
