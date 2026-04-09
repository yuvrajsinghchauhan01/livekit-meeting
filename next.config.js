/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  experimental: {
    serverComponentsExternalPackages: ["@ricky0123/vad-node", "onnxruntime-node"],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : []),
        "@ricky0123/vad-node",
        "onnxruntime-node",
      ];
    }
    return config;
  },
};

module.exports = nextConfig;
