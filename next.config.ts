import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ['firebase-admin'],
  eslint: { ignoreDuringBuilds: true },
}

export default nextConfig
