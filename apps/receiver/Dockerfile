FROM golang:1.25-alpine AS builder

WORKDIR /app

# Copy go-shared first
COPY apps/go-shared ./apps/go-shared

# Copy receiver
COPY apps/receiver ./apps/receiver

WORKDIR /app/apps/receiver

RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -o /receiver .

FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /

COPY --from=builder /receiver /receiver

EXPOSE 3001

CMD ["/receiver"]
