// @flow

import { gt, lt } from 'biggystring'
import {
  SwapAboveLimitError,
  SwapBelowLimitError,
  SwapPermissionError
} from 'edge-core-js'
import { EdgeFetchResponse } from 'edge-core-js/lib/types/types'
import {
  type EdgeCorePluginOptions,
  type EdgeCurrencyWallet,
  type EdgeSpendInfo,
  type EdgeSwapInfo,
  type EdgeSwapPlugin,
  type EdgeSwapQuote,
  type EdgeSwapRequest,
  type EdgeTransaction,
  SwapCurrencyError
} from 'edge-core-js/types'

import { makeSwapPluginQuote } from '../swap-helpers.js'

// const INVALID_CURRENCY_CODES = {} // TODO: anything to add here?

// Invalid currency codes should *not* have transcribed codes
// because currency codes with transcribed versions are NOT invalid
const CURRENCY_CODE_TRANSCRIPTION = {
  // Edge currencyCode: exchangeCurrencyCode
  // TODO: any other transcription neeeded?
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
  settlMethod: string,
  depositAmount: string
}

type OrderRequest = {
  createdAt: string,
  createdAtISO: string,
  expiresAt: Date,
  expiresAtIso: string,
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
  createOrder: boolean
}

const dontUseLegacy = {
  DGB: true
}

async function getAddress(
  wallet: EdgeCurrencyWallet,
  currencyCode: string
): Promise<string> {
  const addressInfo = await wallet.getReceiveAddress({ currencyCode })
  return addressInfo.legacyAddress && !dontUseLegacy[currencyCode]
    ? addressInfo.legacyAddress
    : addressInfo.publicAddress
}

async function checkReplyForError(
  uri: string,
  reply: EdgeFetchResponse
): Promise<any> {
  try {
    await reply.json()
  } catch (e) {
    throw new Error(`SideShift.ai returned error code ${reply.status}`)
  }
}

async function checkRateForError(
  rate: Rate,
  request: EdgeSwapRequest
): Promise<any> {
  if (rate.error) {
    throw new SwapCurrencyError(
      swapInfo,
      request.fromCurrencyCode,
      request.toCurrencyCode
    )
  }
  const nativeMin = await request.fromWallet.denominationToNative(
    rate.min,
    request.fromCurrencyCode
  )

  const nativeMax = await request.fromWallet.denominationToNative(
    rate.max,
    request.fromCurrencyCode
  )

  if (lt(request.nativeAmount, nativeMin)) {
    throw new SwapBelowLimitError(swapInfo, nativeMin)
  }

  if (gt(request.nativeAmount, nativeMax)) {
    throw new SwapAboveLimitError(swapInfo, nativeMax)
  }
}

export function makeSideShiftPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { io, initOptions } = opts
  const { fetch = io.fetch } = io
  const baseUrl = 'https://sideshift.ai/api/'

  async function get(path: string): Promise<any> {
    const url = `${baseUrl}${path}`
    const reply = await fetch(url)
    return reply
  }

  async function post(path, body): Promise<any> {
    const url = `${baseUrl}${path}`
    const reply = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    return checkReplyForError(url, reply)
  }

  const out: EdgeSwapPlugin = {
    swapInfo,
    async fetchSwapQuote(request: EdgeSwapRequest): Promise<EdgeSwapQuote> {
      const permission: Permission = await get('permissions')

      if (!permission.createOrder) {
        throw new SwapPermissionError(swapInfo, 'geoRestriction')
      }

      const [depositAddress, settleAddress] = await Promise.all([
        getAddress(request.fromWallet, request.fromCurrencyCode),
        getAddress(request.toWallet, request.toCurrencyCode)
      ])
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

      let safeFromCurrencyCode = request.fromCurrencyCode.toLowerCase()
      let safeToCurrencyCode = request.toCurrencyCode.toLowerCase()
      if (CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]) {
        safeFromCurrencyCode =
          CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]
      }
      if (CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]) {
        safeToCurrencyCode = CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]
      }

      const ratePath =
        request.quoteFor === 'from'
          ? `pairs/${safeFromCurrencyCode}/${safeToCurrencyCode}`
          : `pairs/${safeToCurrencyCode}/${safeFromCurrencyCode}`

      const rate: Rate = await get(ratePath)

      await checkRateForError(rate, request)

      const fixedRateQuoteParams: FixedQuoteRequestParams = {
        depositMethod: safeFromCurrencyCode,
        settlMethod: safeToCurrencyCode,
        depositAmount: quoteAmount
      }

      const fixedRateQuote: FixedQuote = await post(
        'quotes',
        fixedRateQuoteParams
      )

      const orderRequestParams: OrderRequestParams = {
        type: 'fixed',
        quoteId: fixedRateQuote.id,
        affiliateId: initOptions.affiliateId, // TODO: hardcode it in the .env.json
        sessionSecret: 'this can be empty right?',
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
            publicAddress: quoteInfo.settleAddress.address,
            uniqueIdentifier: quoteInfo.id || undefined // TODO: not sure if this is right or we need this
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
          payoutCurrencyCode: request.toCurrencyCode,
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
        'sideshift',
        false,
        quoteInfo.expiresAt,
        quoteInfo.id
      )
    }
  }

  return out
}
