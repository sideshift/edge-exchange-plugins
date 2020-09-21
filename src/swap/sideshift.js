// @flow

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
const SIDESHIFT_BASE_URL = 'https://sideshift.ai/api/v1/'
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
  settleMethod: string,
  error?: { message: string }
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

function getSafeCurrencyCode(request: EdgeSwapRequest) {
  const { fromCurrencyCode, toCurrencyCode } = request
  let safeFromCurrencyCode = fromCurrencyCode.toLowerCase()
  let safeToCurrencyCode = toCurrencyCode.toLowerCase()
  if (CURRENCY_CODE_TRANSCRIPTION[fromCurrencyCode]) {
    safeFromCurrencyCode = CURRENCY_CODE_TRANSCRIPTION[fromCurrencyCode]
  }
  if (CURRENCY_CODE_TRANSCRIPTION[toCurrencyCode]) {
    safeToCurrencyCode = CURRENCY_CODE_TRANSCRIPTION[toCurrencyCode]
  }
  return { safeFromCurrencyCode, safeToCurrencyCode }
}

async function checkQuoteError(
  rate: Rate,
  request: EdgeSwapRequest,
  quoteErrorMessage: string
): Promise<any> {
  const { fromCurrencyCode, fromWallet } = request

  const nativeMin = await fromWallet.denominationToNative(
    rate.min,
    fromCurrencyCode
  )

  const nativeMax = await fromWallet.denominationToNative(
    rate.max,
    fromCurrencyCode
  )

  if (quoteErrorMessage === 'Amount too low') {
    throw new SwapBelowLimitError(swapInfo, nativeMin)
  }

  if (quoteErrorMessage === 'Amount too high') {
    throw new SwapAboveLimitError(swapInfo, nativeMax)
  }
}

export function makeSideshiftPlugin(
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { io, initOptions } = opts

  async function createSideShiftApi(path: string, method: string, body = null) {
    const url = `${SIDESHIFT_BASE_URL}${path}`
    const reply: EdgeFetchResponse = await (method === 'get'
      ? io.fetch(url)
      : io.fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }))
    try {
      return await reply.json()
    } catch (e) {
      throw new Error(`SideShift.ai returned error code ${reply.status}`)
    }
  }

  const out: EdgeSwapPlugin = {
    swapInfo,
    async fetchSwapQuote(request: EdgeSwapRequest): Promise<EdgeSwapQuote> {
      const permission: Permission = await createSideShiftApi(
        'permissions',
        'get'
      )

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

      const {
        safeFromCurrencyCode,
        safeToCurrencyCode
      } = await getSafeCurrencyCode(request)

      const rate: Rate = await createSideShiftApi(
        `pairs/${safeFromCurrencyCode}/${safeToCurrencyCode}`,
        'get'
      )

      if (rate.error) {
        throw new SwapCurrencyError(
          swapInfo,
          request.fromCurrencyCode,
          request.toCurrencyCode
        )
      }

      const quoteAmount = await (request.quoteFor === 'from'
        ? request.fromWallet.nativeToDenomination(
            request.nativeAmount,
            request.fromCurrencyCode
          )
        : request.toWallet.nativeToDenomination(
            request.nativeAmount,
            request.toCurrencyCode
          ))

      const depositAmount =
        request.quoteFor === 'from'
          ? quoteAmount
          : (parseFloat(quoteAmount) / rate.rate).toFixed(8).toString()

      const fixedRateQuoteParams: FixedQuoteRequestParams = {
        depositMethod: safeFromCurrencyCode,
        settleMethod: safeToCurrencyCode,
        depositAmount
      }

      const fixedRateQuote: FixedQuote = await createSideShiftApi(
        'quotes',
        'post',
        fixedRateQuoteParams
      )

      if (fixedRateQuote.error) {
        await checkQuoteError(rate, request, fixedRateQuote.error.message)
      }

      const orderRequestParams: OrderRequestParams = {
        type: 'fixed',
        quoteId: fixedRateQuote.id,
        affiliateId: initOptions.affiliateId,
        settleAddress
      }

      const quoteInfo: OrderRequest = await createSideShiftApi(
        'orders',
        'post',
        orderRequestParams
      )

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
        new Date(quoteInfo.expiresAtISO),
        quoteInfo.id
      )
    }
  }

  return out
}
