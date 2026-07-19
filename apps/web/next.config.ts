import type { NextConfig } from 'next';
import { API_BASE_URL } from './lib/config';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_BASE_URL}/api/:path*` },
      { source: '/health', destination: `${API_BASE_URL}/health` },
    ];
  },
};

export default nextConfig;
