import { z } from 'zod'

export const linkPurchaseBodySchema = z.object({
  transactionId: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1).optional(),
  signedTransactionInfo: z.string().trim().min(1).optional(),
  restoring: z.boolean().optional(),
})

export const syncRenewalBodySchema = z.object({
  renewalProductId: z.string().trim().min(1),
  signedRenewalInfo: z.string().trim().min(1),
})

export const identitySessionBodySchema = z.object({
  phone: z.string().trim().min(1).optional(),
})

export const referralRedeemBodySchema = z.object({
  referralCode: z.string().trim().min(1),
  source: z.string().trim().min(1).optional(),
})

export const pokeSendBodySchema = z.object({
  toUserId: z.string().trim().min(1),
})

export const registerPhotoBodySchema = z.object({
  imageUrl: z.string().trim().url(),
})
