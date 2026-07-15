import { NextRequest, NextResponse } from 'next/server'
import { deleteRidgitsAccount } from '@/lib/account/delete-account'
import { isNextResponse, requireRidgitsAuthAndAppCheck } from '@/lib/ridgits-auth'

export async function DELETE(request: NextRequest) {
  const auth = await requireRidgitsAuthAndAppCheck(request)
  if (isNextResponse(auth)) return auth

  try {
    await deleteRidgitsAccount(auth.uid)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('deleteRidgitsAccount failed', auth.uid, error)
    return NextResponse.json({ error: 'Failed to delete account.' }, { status: 500 })
  }
}
