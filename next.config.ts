import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ['firebase-admin', '@aws-sdk/client-rekognition'],
  eslint: { ignoreDuringBuilds: true },
}

export default nextConfig
