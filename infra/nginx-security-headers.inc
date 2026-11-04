# Included by each static location: a location's own add_header would replace server-level ones.
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(self), geolocation=(self), microphone=()" always;
# infra/csp-hashes.mjs fills in the script hashes at image build. Map tiles are the only outside
# images. media-src and frame-src allow the HTTPS camera gateways tenants configure.
add_header Content-Security-Policy "default-src 'self'; script-src 'self' __INLINE_SCRIPT_HASHES__; img-src 'self' data: blob: https://server.arcgisonline.com https://tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self'; media-src 'self' blob: https:; frame-src https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
