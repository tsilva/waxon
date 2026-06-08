#!/usr/bin/env python3
"""Interactive CLI driver for Waxon Learn mode.

Run this while the Next.js dev server is running, for example:

    python3 scripts/learn-cli.py --deck-name "Japanese - Hiragana" --coverage "Japanese hiragana"

Use an existing deck with --deck-id or --deck-name. If --deck-name is missing
and --coverage is provided, the script creates the deck in review rotation.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


DEFAULT_BASE_URL = "http://localhost:3001"
LEARN_TARGET_REMAINING = 2
EVALUATION_POLL_SECONDS = 0.75
EVALUATION_TIMEOUT_SECONDS = 150


class ApiError(RuntimeError):
    def __init__(
        self,
        message: str,
        status: int | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


@dataclass
class Deck:
    id: str
    name: str
    coverage: str


@dataclass
class Question:
    question_id: str
    question: str
    deck_id: str
    deck_name: str
    queue_remaining: int


@dataclass
class PreviousAnswer:
    question: str
    answer: str
    score: int | None
    justification: str


class WaxonClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> Any:
        body = None
        headers = {"Accept": "application/json"}

        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers=headers,
            method=method,
        )

        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raw_body = error.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(raw_body)
            except json.JSONDecodeError:
                data = {"error": raw_body}
            message = data.get("error") or data
            retry_after = error.headers.get("Retry-After")
            raise ApiError(
                f"{method} {path} failed ({error.code}): {message}",
                status=error.code,
                retry_after=(
                    int(retry_after)
                    if retry_after and retry_after.isdigit()
                    else None
                ),
            ) from error
        except urllib.error.URLError as error:
            raise ApiError(
                f"Could not reach {self.base_url}. Start the dev server first."
            ) from error

    def list_decks(self) -> list[Deck]:
        data = self.request("GET", "/api/decks")
        return [
            Deck(
                id=str(deck["id"]),
                name=str(deck["name"]),
                coverage=str(deck.get("coverage") or ""),
            )
            for deck in data.get("decks", [])
        ]

    def create_deck(self, name: str, coverage: str) -> Deck:
        data = self.request(
            "POST",
            "/api/decks",
            {
                "name": name,
                "coverage": coverage,
                "inReviewRotation": True,
            },
        )
        deck = data["deck"]
        return Deck(
            id=str(deck["id"]),
            name=str(deck["name"]),
            coverage=str(deck.get("coverage") or ""),
        )

    def archive_deck(self, deck_id: str) -> None:
        data = self.request("DELETE", f"/api/decks/{urllib.parse.quote(deck_id)}")

        if not data.get("ok"):
            raise ApiError(str(data.get("error") or "Could not archive deck."))

    def queue_status(self, deck_id: str, limit: int = 200) -> dict[str, Any]:
        params = urllib.parse.urlencode(
            {
                "deckId": deck_id,
                "limit": limit,
                "sort": "creation-date",
            }
        )
        return self.request("GET", f"/api/queue-status?{params}")

    def next_question(
        self,
        deck_id: str,
        exclude_question_id: str | None = None,
        exclude_question: str | None = None,
    ) -> Question | None:
        params = {
            "mode": "learn",
            "deckId": deck_id,
        }

        if exclude_question_id:
            params["excludeQuestionId"] = exclude_question_id
        if exclude_question:
            params["excludeQuestion"] = exclude_question

        data = self.request("GET", f"/api/next-question?{urllib.parse.urlencode(params)}")
        question = data.get("question")
        question_id = data.get("questionId")

        if not question or not question_id:
            return None

        return Question(
            question_id=str(question_id),
            question=str(question),
            deck_id=str(data.get("deckId") or deck_id),
            deck_name=str(data.get("deckName") or deck_id),
            queue_remaining=int(data.get("queueRemaining") or 0),
        )

    def generate_learn_questions(
        self,
        deck_id: str,
        count: int,
        current_question: Question | None,
        previous_answers: list[PreviousAnswer],
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "deckId": deck_id,
            "count": max(1, min(LEARN_TARGET_REMAINING, count)),
            "previousAnswers": [
                {
                    "question": item.question,
                    "answer": item.answer,
                    "score": item.score,
                    "justification": item.justification,
                }
                for item in previous_answers[-12:]
            ],
        }

        if current_question is not None:
            payload["sourceDeckId"] = current_question.deck_id
            payload["currentQuestion"] = current_question.question

        for attempt in range(1, 4):
            try:
                data = self.request("POST", "/api/questions/learn", payload)
                break
            except ApiError as error:
                if error.status != 429 or attempt == 3:
                    raise

                delay = min(60, max(1, error.retry_after or 10))
                print(f"[learn] rate limited; retrying in {delay}s...")
                time.sleep(delay)

        if not data.get("ok"):
            raise ApiError(str(data.get("error") or "Could not generate learn questions."))

        return data

    def submit_answer(self, question: Question, answer: str) -> str:
        data = self.request(
            "POST",
            "/api/submit-answer",
            {
                "questionId": question.question_id,
                "question": question.question,
                "answer": answer,
            },
        )

        if not data.get("ok"):
            raise ApiError(str(data.get("error") or "Could not submit answer."))

        return str(data["evaluationId"])

    def evaluation(self, evaluation_id: str) -> dict[str, Any] | None:
        params = urllib.parse.urlencode({"evaluationId": evaluation_id})
        data = self.request("GET", f"/api/evaluation-status?{params}")
        evaluations = data.get("evaluations") or []
        return evaluations[0] if evaluations else None


def choose_deck(client: WaxonClient, args: argparse.Namespace) -> Deck:
    decks = client.list_decks()

    if args.list_decks:
        for deck in decks:
            coverage = f" — {deck.coverage}" if deck.coverage else ""
            print(f"{deck.id}\t{deck.name}{coverage}")
        raise SystemExit(0)

    if args.deck_id:
        for deck in decks:
            if deck.id == args.deck_id:
                return deck
        raise ApiError(f"Deck id not found: {args.deck_id}")

    if args.deck_name:
        if args.reset_deck:
            if not args.coverage:
                raise ApiError("--reset-deck requires --coverage.")

            for deck in decks:
                if deck.name.lower() == args.deck_name.lower():
                    print(f"[deck] archiving existing deck {deck.name} ({deck.id})")
                    client.archive_deck(deck.id)

            return client.create_deck(args.deck_name, args.coverage)

        for deck in decks:
            if deck.name.lower() == args.deck_name.lower():
                return deck

        if args.coverage:
            return client.create_deck(args.deck_name, args.coverage)

        raise ApiError(
            f"Deck name not found: {args.deck_name}. Pass --coverage to create it."
        )

    if len(decks) == 1:
        return decks[0]

    raise ApiError("Pass --deck-id, --deck-name, or --list-decks.")


def ensure_learn_buffer(
    client: WaxonClient,
    deck: Deck,
    current_question: Question | None,
    previous_answers: list[PreviousAnswer],
) -> Question | None:
    next_question = client.next_question(
        deck.id,
        exclude_question_id=current_question.question_id if current_question else None,
        exclude_question=current_question.question if current_question else None,
    )
    ready_count = next_question.queue_remaining if next_question else 0

    if ready_count >= LEARN_TARGET_REMAINING:
        return next_question

    needed = LEARN_TARGET_REMAINING - ready_count
    print(f"[learn] generating {needed} question{'s' if needed != 1 else ''}...")
    try:
        result = client.generate_learn_questions(
            deck.id,
            needed,
            current_question,
            previous_answers,
        )
    except ApiError as error:
        fallback = client.next_question(
            deck.id,
            exclude_question_id=current_question.question_id if current_question else None,
            exclude_question=current_question.question if current_question else None,
        )
        if fallback is not None:
            print(f"[learn] top-up failed; continuing with ready queue: {error}")
            return fallback
        raise
    added = int(result.get("added") or 0)
    rejected = int(result.get("rejected") or 0)
    done = bool(result.get("done"))
    done_label = " done=true" if done else ""
    print(f"[learn] added={added} rejected={rejected}{done_label}")

    return client.next_question(
        deck.id,
        exclude_question_id=current_question.question_id if current_question else None,
        exclude_question=current_question.question if current_question else None,
    )


def wait_for_evaluation(client: WaxonClient, evaluation_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + EVALUATION_TIMEOUT_SECONDS

    while time.monotonic() < deadline:
        evaluation = client.evaluation(evaluation_id)

        if evaluation and evaluation.get("status") == "resolved":
            return evaluation

        phase = evaluation.get("phase") if evaluation else "queued"
        print(f"[grading] {phase or 'grading'}...", end="\r", flush=True)
        time.sleep(EVALUATION_POLL_SECONDS)

    raise ApiError(f"Timed out waiting for evaluation {evaluation_id}")


def print_evaluation(evaluation: dict[str, Any]) -> None:
    print(" " * 80, end="\r")
    print(f"score: {evaluation.get('score')}")

    answer_summary = evaluation.get("answerSummary")
    if answer_summary:
        print(f"answer: {answer_summary}")

    justification = evaluation.get("justification")
    if justification:
        print(f"why: {justification}")


def concise_answer_for_question(client: WaxonClient, question: Question) -> str:
    status = client.queue_status(question.deck_id)

    for item in status.get("reviewQueue") or []:
        if str(item.get("questionId")) == question.question_id:
            answer = str(item.get("conciseAnswer") or "").strip()
            if answer:
                return answer

    raise ApiError(
        f"No stored concise answer found for question {question.question_id}."
    )


def run_loop(client: WaxonClient, deck: Deck, args: argparse.Namespace) -> None:
    print(f"deck: {deck.name} ({deck.id})")
    if deck.coverage:
        print(f"goal: {deck.coverage}")
    print("commands: /quit, /refresh")
    print()

    current_question: Question | None = None
    previous_answers: list[PreviousAnswer] = []
    answered_count = 0

    while True:
        if args.max_answers and answered_count >= args.max_answers:
            print(f"[done] stopped after {answered_count} answers")
            return

        if current_question is None:
            current_question = client.next_question(deck.id)

        if current_question is None:
            current_question = ensure_learn_buffer(
                client,
                deck,
                None,
                previous_answers,
            )

        if current_question is None:
            print("No question is ready. The deck may be fully covered.")
            if args.auto_answer:
                print("[done] no ready question remains")
                return
            command = input("> ").strip()
            if command in {"/quit", "/q"}:
                return
            continue

        ensure_learn_buffer(client, deck, current_question, previous_answers)
        print()
        print(f"question: {current_question.question}")

        if args.auto_answer:
            answer = concise_answer_for_question(client, current_question)
            print(f"answer> {answer}")
        else:
            answer = input("answer> ").strip()

        if answer in {"/quit", "/q"}:
            return

        if answer == "/refresh":
            current_question = None
            continue

        evaluation_id = client.submit_answer(current_question, answer)
        evaluation = wait_for_evaluation(client, evaluation_id)
        print_evaluation(evaluation)
        if args.auto_answer and not isinstance(evaluation.get("score"), int):
            raise ApiError(
                "Auto-validation stopped because grading did not produce a score."
            )
        previous_answers.append(
            PreviousAnswer(
                question=current_question.question,
                answer=answer,
                score=(
                    int(evaluation["score"])
                    if isinstance(evaluation.get("score"), int)
                    else None
                ),
                justification=str(evaluation.get("justification") or ""),
            )
        )
        answered_count += 1
        current_question = client.next_question(
            deck.id,
            exclude_question_id=current_question.question_id,
            exclude_question=current_question.question,
        )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Drive Waxon Learn mode from the terminal."
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Waxon app URL. Default: {DEFAULT_BASE_URL}",
    )
    parser.add_argument("--deck-id", help="Use an existing deck id.")
    parser.add_argument("--deck-name", help="Use or create a deck by exact name.")
    parser.add_argument(
        "--coverage",
        help="Deck goal/coverage. Creates --deck-name when it does not exist.",
    )
    parser.add_argument(
        "--list-decks",
        action="store_true",
        help="List active decks and exit.",
    )
    parser.add_argument(
        "--reset-deck",
        action="store_true",
        help="Archive an existing --deck-name match and create a fresh empty deck.",
    )
    parser.add_argument(
        "--auto-answer",
        action="store_true",
        help="Automatically answer each question with its stored concise answer.",
    )
    parser.add_argument(
        "--max-answers",
        type=int,
        default=0,
        help="Stop after this many submitted answers. Default: no explicit cap.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    client = WaxonClient(args.base_url)

    try:
        deck = choose_deck(client, args)
        run_loop(client, deck, args)
    except KeyboardInterrupt:
        print()
        return 130
    except ApiError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
