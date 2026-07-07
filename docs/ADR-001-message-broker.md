# ADR-001 Message Broker

## Decision
Use RabbitMQ for the first development environment.

## Alternatives
Kafka, Redis Streams.

## Rationale
RabbitMQ is lighter for local development, supports acknowledgements and dead-letter queues directly, and is enough for MVP event-driven ETL. Kafka remains a later option for high-volume streaming.
