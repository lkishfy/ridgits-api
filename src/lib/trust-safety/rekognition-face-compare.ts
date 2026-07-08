import { CompareFacesCommand, RekognitionClient } from '@aws-sdk/client-rekognition'
import { ApiError } from '@/lib/api-errors'

let rekognitionClient: RekognitionClient | null = null

export function isRekognitionConfigured(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID?.trim() &&
      process.env.AWS_SECRET_ACCESS_KEY?.trim(),
  )
}

function getRekognitionClient(): RekognitionClient {
  if (rekognitionClient) return rekognitionClient

  const region = process.env.AWS_REGION?.trim() || 'us-east-1'
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  if (!accessKeyId || !secretAccessKey) {
    throw new ApiError('Face match is not configured.', 503, 'FACE_MATCH_UNAVAILABLE')
  }

  rekognitionClient = new RekognitionClient({
    region,
    credentials: { accessKeyId, secretAccessKey },
  })
  return rekognitionClient
}

export async function downloadImageBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) {
    throw new ApiError('Could not download image for face comparison.', 502, 'FACE_MATCH_FAILED')
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType && !contentType.startsWith('image/')) {
    throw new ApiError('Image URL does not point to a photo.', 412, 'INVALID_PROFILE_PHOTO')
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0) {
    throw new ApiError('Image file is empty.', 412, 'FACE_MATCH_FAILED')
  }
  if (bytes.length > 5 * 1024 * 1024) {
    throw new ApiError('Image is too large for face comparison.', 412, 'FACE_MATCH_FAILED')
  }

  return bytes
}

/** Best-effort wipe of downloaded image bytes after face comparison. */
export function secureClearBuffer(buffer: Buffer | null | undefined): void {
  if (!buffer?.length) return
  buffer.fill(0)
}

function rekognitionErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = String((error as { name?: string }).name ?? '')
    if (name === 'InvalidParameterException') {
      return 'Could not detect a face in one of the photos. Use a clear photo of your face.'
    }
    if (name === 'ImageTooLargeException') {
      return 'Image is too large for face comparison.'
    }
    if (name === 'AccessDeniedException') {
      return 'Face comparison is not configured correctly.'
    }
  }
  return 'Face comparison failed.'
}

/**
 * Compare two face photos with Amazon Rekognition.
 * Returns a normalized similarity score in the 0–1 range.
 */
export async function compareFacesWithRekognition(
  sourceBytes: Buffer,
  targetBytes: Buffer,
  similarityThreshold: number,
): Promise<{ match: boolean; score: number }> {
  const rekognition = getRekognitionClient()
  const thresholdPercent = Math.max(0, Math.min(100, similarityThreshold * 100))

  try {
    const response = await rekognition.send(
      new CompareFacesCommand({
        SourceImage: { Bytes: sourceBytes },
        TargetImage: { Bytes: targetBytes },
        SimilarityThreshold: 0,
        QualityFilter: 'AUTO',
      }),
    )

    const similarityPercent = response.FaceMatches?.[0]?.Similarity ?? 0
    const score = similarityPercent / 100
    const match = score >= similarityThreshold

    if (similarityPercent === 0 && !response.SourceImageFace) {
      throw new ApiError(
        'Could not detect a face in your profile photo. Use a clear photo of your face.',
        412,
        'FACE_MATCH_FAILED',
      )
    }

    if (similarityPercent === 0 && (response.UnmatchedFaces?.length ?? 0) === 0) {
      throw new ApiError(
        'Could not detect a face in your verified ID selfie.',
        412,
        'FACE_MATCH_FAILED',
      )
    }

    return { match, score }
  } catch (error) {
    if (error instanceof ApiError) throw error
    const message = rekognitionErrorMessage(error)
    const code =
      message.includes('not configured correctly') ? 'FACE_MATCH_UNAVAILABLE' : 'FACE_MATCH_FAILED'
    throw new ApiError(message, code === 'FACE_MATCH_UNAVAILABLE' ? 503 : 412, code)
  }
}
