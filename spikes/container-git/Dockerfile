# The image from developers.cloudflare.com/sandbox/network/clone-a-private-repository/
FROM node:24-trixie-slim
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends ca-certificates git \
	&& rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]
