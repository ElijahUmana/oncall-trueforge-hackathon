from __future__ import annotations

import sqlite3
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass


class CheckoutDeadlineExceeded(RuntimeError):
    pass


@dataclass(frozen=True)
class OrderItem:
    sku: str
    quantity: int


class OrderRepository:
    def __init__(
        self,
        database_path: str,
        round_trip_seconds: float,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._database_path = database_path
        self._round_trip_seconds = round_trip_seconds
        self._sleep = sleep
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._database_path)
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS order_items (
                    order_id TEXT NOT NULL,
                    sku TEXT NOT NULL,
                    quantity INTEGER NOT NULL CHECK (quantity > 0),
                    PRIMARY KEY (order_id, sku)
                )
                """
            )

    def insert_items(self, order_id: str, items: Sequence[OrderItem]) -> None:
        with self._connect() as connection:
            for item in items:
                self._sleep(self._round_trip_seconds)
                connection.execute(
                    "INSERT INTO order_items (order_id, sku, quantity) VALUES (?, ?, ?)",
                    (order_id, item.sku, item.quantity),
                )

    def count_items(self, order_id: str) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) FROM order_items WHERE order_id = ?", (order_id,)
            ).fetchone()
        return int(row[0])


class CheckoutService:
    def __init__(
        self,
        repository: OrderRepository,
        deadline_seconds: float,
        request_overhead_seconds: float,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._repository = repository
        self._deadline_seconds = deadline_seconds
        self._request_overhead_seconds = request_overhead_seconds
        self._clock = clock
        self._sleep = sleep

    def complete(self, order_id: str, items: Sequence[OrderItem]) -> float:
        if not order_id:
            raise ValueError("order_id must not be empty")
        if not items:
            raise ValueError("items must not be empty")
        if any(not item.sku or item.quantity <= 0 for item in items):
            raise ValueError("each item requires a sku and a positive quantity")
        if len({item.sku for item in items}) != len(items):
            raise ValueError("item skus must be unique within an order")

        started_at = self._clock()
        self._sleep(self._request_overhead_seconds)
        self._repository.insert_items(order_id, items)
        elapsed_seconds = self._clock() - started_at
        if elapsed_seconds > self._deadline_seconds:
            raise CheckoutDeadlineExceeded(
                f"checkout exceeded {self._deadline_seconds:.3f}s deadline "
                f"after {elapsed_seconds:.3f}s"
            )
        return elapsed_seconds
