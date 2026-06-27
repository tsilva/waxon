#!/usr/bin/env python3
"""Terminal client for the Waxon Learn flow.

This script intentionally talks to the same HTTP API as the browser Learn UI:

- GET /api/courses
- GET /api/courses/{courseId}
- POST /api/courses/chat
- POST /api/courses/chat/prompt-preview

It does not call the model provider directly or reimplement tutor decisions.
Run it against a local dev server for local-test auth, or pass cookies for a
deployed app.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable


JsonObject = dict[str, Any]
SseHandler = Callable[[str, Any], None]


COURSE_QUESTION_WIDGET_TOOL_NAME = "render_question_widget"
COURSE_TOC_TOOL_NAME = "generate_course_toc"


@dataclass
class CourseState:
    course: JsonObject | None = None
    chat_messages: list[JsonObject] = field(default_factory=list)
    draft_toc: JsonObject | None = None
    user: JsonObject | None = None
    due_count: int | None = None


@dataclass
class Ui:
    base_url: str
    color: bool
    width: int
    history_limit: int

    def style(self, code: str, text: str) -> str:
        if not self.color:
            return text
        return f"\033[{code}m{text}\033[0m"

    def bold(self, text: str) -> str:
        return self.style("1", text)

    def dim(self, text: str) -> str:
        return self.style("2", text)

    def green(self, text: str) -> str:
        return self.style("32", text)

    def yellow(self, text: str) -> str:
        return self.style("33", text)

    def red(self, text: str) -> str:
        return self.style("31", text)

    def cyan(self, text: str) -> str:
        return self.style("36", text)

    def clear(self) -> None:
        if self.color and sys.stdout.isatty():
            print("\033[2J\033[H", end="")


class WaxonApiError(RuntimeError):
    pass


class WaxonClient:
    def __init__(
        self,
        base_url: str,
        *,
        cookie: str | None,
        authorization: str | None,
        timeout: float,
        raw_events: bool,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.cookie = cookie
        self.authorization = authorization
        self.timeout = timeout
        self.raw_events = raw_events

    def _url(self, path: str) -> str:
        if not path.startswith("/"):
            path = f"/{path}"
        return f"{self.base_url}{path}"

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "Accept": "application/json, text/event-stream",
            "User-Agent": "waxon-learn-tui/1.0",
        }
        if self.cookie:
            headers["Cookie"] = self.cookie
        if self.authorization:
            headers["Authorization"] = self.authorization
        if extra:
            headers.update(extra)
        return headers

    def request_json(
        self,
        method: str,
        path: str,
        body: JsonObject | None = None,
    ) -> JsonObject:
        data = None
        headers = self._headers()
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(
            self._url(path),
            data=data,
            headers=headers,
            method=method,
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw_body = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as error:
            raise self._http_error(error) from error
        except urllib.error.URLError as error:
            raise WaxonApiError(f"Could not reach {self._url(path)}: {error.reason}") from error

        try:
            parsed = json.loads(raw_body)
        except json.JSONDecodeError as error:
            raise WaxonApiError(f"Expected JSON from {path}, got: {raw_body[:500]}") from error

        if not isinstance(parsed, dict):
            raise WaxonApiError(f"Expected an object response from {path}.")
        if parsed.get("ok") is False:
            raise WaxonApiError(str(parsed.get("error") or f"{method} {path} failed."))
        return parsed

    def stream_chat(
        self,
        *,
        course_id: str | None,
        content: str,
        widget_answer: JsonObject | None,
        on_event: SseHandler,
    ) -> None:
        body: JsonObject = {
            "message": {
                "content": content,
                "widgetAnswer": widget_answer,
            },
        }
        if course_id:
            body["courseId"] = course_id

        request = urllib.request.Request(
            self._url("/api/courses/chat"),
            data=json.dumps(body).encode("utf-8"),
            headers=self._headers({"Content-Type": "application/json"}),
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                self._read_sse(response, on_event)
        except urllib.error.HTTPError as error:
            raise self._http_error(error) from error
        except urllib.error.URLError as error:
            raise WaxonApiError(
                f"Could not reach {self._url('/api/courses/chat')}: {error.reason}"
            ) from error

    def _read_sse(self, response: Any, on_event: SseHandler) -> None:
        buffer = ""

        while True:
            chunk = response.read(4096)
            if not chunk:
                break

            buffer += chunk.decode("utf-8", errors="replace")

            while "\n\n" in buffer:
                raw_event, buffer = buffer.split("\n\n", 1)
                parsed = parse_sse_event(raw_event)
                if not parsed:
                    continue

                event, data = parsed
                if self.raw_events:
                    print(f"\n{event}: {json.dumps(data, ensure_ascii=False)}")
                on_event(event, data)

    def _http_error(self, error: urllib.error.HTTPError) -> WaxonApiError:
        raw_body = error.read().decode("utf-8", errors="replace")
        message = raw_body.strip() or error.reason

        try:
            parsed = json.loads(raw_body)
            if isinstance(parsed, dict) and parsed.get("error"):
                message = str(parsed["error"])
        except json.JSONDecodeError:
            pass

        return WaxonApiError(f"HTTP {error.code}: {message}")


def parse_sse_event(raw_event: str) -> tuple[str, Any] | None:
    event = ""
    data_lines: list[str] = []

    for line in raw_event.splitlines():
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())

    if not event or not data_lines:
        return None

    try:
        return event, json.loads("\n".join(data_lines))
    except json.JSONDecodeError:
        return None


def parse_tool_arguments(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def iter_tool_calls(message: JsonObject) -> list[JsonObject]:
    value = message.get("toolCalls")
    if not isinstance(value, list):
        value = message.get("tool_calls")
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def widgets_from_tool_calls(tool_calls: Any) -> list[JsonObject]:
    if not isinstance(tool_calls, list):
        return []

    widgets: list[JsonObject] = []
    for tool_call in tool_calls:
        if not isinstance(tool_call, dict):
            continue
        function = tool_call.get("function")
        if not isinstance(function, dict):
            continue
        if function.get("name") != COURSE_QUESTION_WIDGET_TOOL_NAME:
            continue

        widget = parse_tool_arguments(function.get("arguments"))
        if isinstance(widget, dict) and isinstance(widget.get("question"), str):
            widgets.append(widget)
    return widgets


def message_widgets(message: JsonObject) -> list[JsonObject]:
    return widgets_from_tool_calls(iter_tool_calls(message))


def has_toc_tool_call(message: JsonObject) -> bool:
    for tool_call in iter_tool_calls(message):
        function = tool_call.get("function")
        if isinstance(function, dict) and function.get("name") == COURSE_TOC_TOOL_NAME:
            return True
    return False


def widget_answers_by_id(messages: list[JsonObject]) -> dict[str, JsonObject]:
    answers: dict[str, JsonObject] = {}
    for message in messages:
        if message.get("role") != "user":
            continue
        answer = message.get("widgetAnswer")
        if not isinstance(answer, dict):
            continue
        widget_id = answer.get("widgetId")
        if isinstance(widget_id, str) and widget_id:
            answers[widget_id] = answer
    return answers


def latest_active_widget(messages: list[JsonObject]) -> JsonObject | None:
    answered_ids = set(widget_answers_by_id(messages))
    widgets: list[JsonObject] = []

    for message in messages:
        if message.get("role") != "assistant":
            continue
        if message.get("evaluation"):
            continue
        widgets.extend(message_widgets(message))

    for widget in reversed(widgets):
        widget_id = widget.get("id")
        if isinstance(widget_id, str) and widget_id not in answered_ids:
            return widget

    return None


def should_render_widget(
    messages: list[JsonObject],
    message_index: int,
    *,
    answered: bool,
) -> bool:
    later_messages = messages[message_index + 1 :]

    if answered:
        return not any(
            message.get("pendingEvaluation") or message.get("evaluation")
            for message in later_messages
        )

    return not any(
        message.get("role") == "user"
        or message.get("pendingEvaluation")
        or message.get("evaluation")
        for message in later_messages
    )


def terminal_width() -> int:
    return max(72, min(120, shutil.get_terminal_size((96, 24)).columns))


def paragraph_wrap(text: str, *, width: int, prefix: str = "") -> str:
    if not text:
        return ""

    wrapped: list[str] = []
    for paragraph in text.splitlines():
        if not paragraph.strip():
            wrapped.append("")
            continue
        wrapped.append(
            textwrap.fill(
                paragraph,
                width=width,
                initial_indent=prefix,
                subsequent_indent=prefix,
                replace_whitespace=False,
                drop_whitespace=False,
            )
        )
    return "\n".join(wrapped)


def render_course_header(ui: Ui, state: CourseState) -> None:
    course = state.course
    print(ui.bold("Waxon Learn TUI"))
    print(ui.dim(f"API: {ui.base_url}"))
    if state.user:
        display_name = str(state.user.get("displayName") or state.user.get("email") or "Waxon user")
        due = f"  {state.due_count} due" if state.due_count is not None else ""
        print(ui.dim(f"User: {display_name}{due}"))
    print()

    if not course:
        print(ui.cyan("New course"))
        print("Type a learning goal, or /courses to resume an existing course.")
        print()
        return

    title = str(course.get("title") or "Untitled course")
    status = str(course.get("status") or "active")
    total_pages = int_or(course.get("totalPages"), course_toc_page_count(course))
    current_index = int_or(course.get("currentPageIndex"), 0)
    current_display = min(current_index + 1, max(total_pages, 1))

    print(ui.bold(title))
    print(
        f"{ui.cyan(status)}  "
        f"milestone {current_display}/{max(total_pages, 1)}  "
        f"id {course.get('id')}"
    )

    toc = course.get("toc") if isinstance(course.get("toc"), dict) else state.draft_toc
    pages = toc.get("pages") if isinstance(toc, dict) else None
    if isinstance(pages, list) and pages:
        current = pages[current_index] if current_index < len(pages) else None
        if isinstance(current, dict):
            current_title = str(current.get("title") or "Current milestone")
            print(f"Current: {current_title}")
    print()


def render_toc(ui: Ui, state: CourseState) -> None:
    course = state.course
    toc = None
    current_index = 0
    if course and isinstance(course.get("toc"), dict):
        toc = course["toc"]
        current_index = int_or(course.get("currentPageIndex"), 0)
    elif state.draft_toc:
        toc = state.draft_toc

    if not isinstance(toc, dict):
        return

    pages = toc.get("pages")
    if not isinstance(pages, list) or not pages:
        return

    print(ui.bold("Table Of Contents"))
    for index, page in enumerate(pages):
        if not isinstance(page, dict):
            continue
        marker = ">" if index == current_index and course else " "
        title = str(page.get("title") or f"Milestone {index + 1}")
        line = f"{marker} {index + 1}. {title}"
        if index == current_index and course:
            print(ui.green(line))
        else:
            print(line)
    print()


def render_widget(ui: Ui, widget: JsonObject, answered: JsonObject | None = None) -> None:
    question = str(widget.get("question") or "Course question")
    widget_type = str(widget.get("type") or "free_text")
    print(ui.bold("Question"))
    print(paragraph_wrap(question, width=ui.width, prefix="  "))

    if widget_type == "multiple_choice":
        choices = widget.get("choices")
        if isinstance(choices, list):
            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                choice_id = str(choice.get("id") or "").strip()
                text = str(choice.get("text") or "").strip()
                if choice_id and text:
                    print(paragraph_wrap(f"{choice_id}) {text}", width=ui.width, prefix="  "))

    if answered and answered.get("answer"):
        print(ui.dim("  Your answer:"))
        print(paragraph_wrap(str(answered["answer"]), width=ui.width, prefix="    "))
    print()


def render_messages(ui: Ui, state: CourseState) -> None:
    messages = state.chat_messages
    if ui.history_limit > 0 and len(messages) > ui.history_limit:
        hidden = len(messages) - ui.history_limit
        messages = messages[-ui.history_limit:]
        print(ui.dim(f"Showing last {ui.history_limit} messages ({hidden} hidden)."))
        print()

    answered = widget_answers_by_id(state.chat_messages)

    for message_index, message in enumerate(messages):
        role = message.get("role")
        if role == "assistant" and has_toc_tool_call(message):
            continue

        if role == "user" and isinstance(message.get("widgetAnswer"), dict):
            continue

        evaluation = message.get("evaluation")
        if role == "assistant" and isinstance(evaluation, dict):
            score = evaluation.get("score")
            question = str(evaluation.get("question") or "Course question")
            feedback = str(evaluation.get("feedback") or message.get("content") or "")
            print(ui.bold(f"Evaluation: {score}/10"))
            print(paragraph_wrap(question, width=ui.width, prefix="  "))
            print(paragraph_wrap(feedback, width=ui.width, prefix="  "))
            print()
            continue

        content = str(message.get("content") or "").strip()
        if content:
            label = "Tutor" if role == "assistant" else "You"
            print(ui.bold(label))
            print(paragraph_wrap(content, width=ui.width, prefix="  "))
            print()

        if role == "assistant":
            for widget in message_widgets(message):
                widget_id = widget.get("id")
                answer = answered.get(widget_id) if isinstance(widget_id, str) else None
                if not should_render_widget(
                    messages,
                    message_index,
                    answered=bool(answer and answer.get("answer")),
                ):
                    continue
                render_widget(ui, widget, answer)


def render_screen(ui: Ui, state: CourseState) -> None:
    ui.clear()
    render_course_header(ui, state)
    render_toc(ui, state)
    render_messages(ui, state)


def int_or(value: Any, fallback: int) -> int:
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return fallback


def course_toc_page_count(course: JsonObject) -> int:
    toc = course.get("toc")
    if not isinstance(toc, dict):
        return 0
    pages = toc.get("pages")
    return len(pages) if isinstance(pages, list) else 0


def course_chat_messages(course: JsonObject | None) -> list[JsonObject]:
    if not course:
        return []
    messages = course.get("chatMessages")
    if not isinstance(messages, list):
        return []
    return [message for message in messages if isinstance(message, dict)]


def load_boot_context(client: WaxonClient, state: CourseState) -> None:
    try:
        state.user = client.request_json("GET", "/api/user")
    except WaxonApiError:
        state.user = None

    try:
        queue = client.request_json(
            "GET",
            "/api/queue-status?"
            "mode=review&includeReviewQueue=0&includeRecentAttempts=0&"
            "includeQuestionAttempts=0&includeKnowledgeEmbeddingPlot=0&"
            "includeQueueCounts=1",
        )
        state.due_count = int_or(queue.get("queueRemaining"), 0)
    except WaxonApiError:
        state.due_count = None


def load_course(client: WaxonClient, course_id: str) -> JsonObject:
    data = client.request_json("GET", f"/api/courses/{urllib.parse.quote(course_id, safe='')}")
    course = data.get("course")
    if not isinstance(course, dict):
        raise WaxonApiError("Course response did not include a course.")
    return course


def list_courses(client: WaxonClient, *, limit: int, search: str = "") -> list[JsonObject]:
    params = {"limit": str(limit)}
    if search.strip():
        params["search"] = search.strip()
    data = client.request_json("GET", f"/api/courses?{urllib.parse.urlencode(params)}")
    courses = data.get("courses")
    if not isinstance(courses, list):
        return []
    return [course for course in courses if isinstance(course, dict)]


def print_courses(ui: Ui, courses: list[JsonObject]) -> None:
    if not courses:
        print("No courses found.")
        return

    for index, course in enumerate(courses, start=1):
        title = str(course.get("title") or "Untitled course")
        status = str(course.get("status") or "active")
        total = int_or(course.get("totalPages"), 0)
        current = int_or(course.get("currentPageIndex"), 0) + 1 if total else 0
        updated = format_time(course.get("updatedAt"))
        print(f"{index:>2}. {title}")
        print(ui.dim(f"    {status}  {current}/{total or '?'}  {updated}  {course.get('id')}"))


def choose_course(client: WaxonClient, ui: Ui, *, limit: int, search: str) -> JsonObject | None:
    courses = list_courses(client, limit=limit, search=search)

    while True:
        ui.clear()
        print(ui.bold("Choose Course"))
        print_courses(ui, courses)
        print()
        print("Enter a number, n for a new course, s to search, r to refresh, or q to quit.")
        choice = input("> ").strip()

        if choice.lower() in {"q", "quit", "/quit"}:
            raise KeyboardInterrupt
        if choice.lower() in {"n", "new", "/new"}:
            return None
        if choice.lower() in {"r", "refresh", "/refresh"}:
            courses = list_courses(client, limit=limit, search=search)
            continue
        if choice.lower() in {"s", "search", "/search"}:
            search = input("Search: ").strip()
            courses = list_courses(client, limit=limit, search=search)
            continue
        if choice.isdigit():
            selected = int(choice)
            if 1 <= selected <= len(courses):
                course_id = str(courses[selected - 1].get("id") or "")
                if course_id:
                    return load_course(client, course_id)
        print("Invalid choice.")
        time.sleep(0.8)


def format_time(value: Any) -> str:
    if not isinstance(value, (int, float)) or value <= 0:
        return "updated unknown"
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(value / 1000))


def read_text(prompt: str) -> str:
    first = input(prompt).rstrip()
    if first:
        return first

    print("Enter multiple lines. Finish with a single '.' on its own line.")
    lines: list[str] = []
    while True:
        line = input()
        if line == ".":
            break
        lines.append(line)
    return "\n".join(lines).strip()


def answer_for_widget(widget: JsonObject) -> str:
    widget_type = str(widget.get("type") or "free_text")
    if widget_type != "multiple_choice":
        return read_text("Answer> ")

    choices = widget.get("choices")
    choice_map: dict[str, str] = {}
    if isinstance(choices, list):
        for index, choice in enumerate(choices, start=1):
            if not isinstance(choice, dict):
                continue
            choice_id = str(choice.get("id") or "").strip()
            choice_text = str(choice.get("text") or "").strip()
            if choice_id and choice_text:
                choice_map[choice_id.lower()] = f"{choice_id}) {choice_text}"
                choice_map[str(index)] = f"{choice_id}) {choice_text}"

    raw = input("Answer (choice id or text)> ").strip()
    return choice_map.get(raw.lower(), raw)


def local_user_message(content: str, widget_answer: JsonObject | None) -> JsonObject:
    return {
        "role": "user",
        "content": content,
        "widgetAnswer": widget_answer,
    }


def submit_turn(
    client: WaxonClient,
    ui: Ui,
    state: CourseState,
    *,
    content: str,
    widget_answer: JsonObject | None,
) -> None:
    if not content.strip():
        return

    course_id = str(state.course.get("id")) if state.course and state.course.get("id") else None
    state.chat_messages.append(local_user_message(content, widget_answer))

    assistant_text = ""
    latest_tool_calls: list[JsonObject] = []
    done_seen = False

    print()

    def on_event(event: str, data: Any) -> None:
        nonlocal assistant_text, latest_tool_calls, done_seen

        if event == "status" and isinstance(data, dict):
            status = data.get("status")
            if isinstance(status, str) and status.strip():
                print(ui.dim(f"[{status.strip()}]"))
        elif event == "toc" and isinstance(data, dict):
            toc = data.get("toc")
            if isinstance(toc, dict):
                state.draft_toc = toc
                title = str(toc.get("title") or "Generating TOC")
                complete = "complete" if data.get("complete") else "partial"
                print(ui.dim(f"[TOC {complete}: {title}]"))
        elif event == "course" and isinstance(data, dict):
            course = data.get("course")
            if isinstance(course, dict):
                state.course = course
                state.draft_toc = None
                print(ui.dim(f"[course: {course.get('title') or course.get('id')}]"))
        elif event == "delta" and isinstance(data, dict):
            delta = data.get("delta")
            if isinstance(delta, str):
                if not assistant_text:
                    print(ui.bold("\nTutor"))
                    print("  ", end="", flush=True)
                assistant_text += delta
                print(delta.replace("\n", "\n  "), end="", flush=True)
        elif event == "question_widget_pending":
            print(ui.dim("\n[question widget pending]"))
        elif event == "question_widget" and isinstance(data, dict):
            raw_tool_calls = data.get("toolCalls")
            if isinstance(raw_tool_calls, list):
                latest_tool_calls = [item for item in raw_tool_calls if isinstance(item, dict)]
                print()
                for widget in widgets_from_tool_calls(latest_tool_calls):
                    render_widget(ui, widget)
        elif event == "evaluation_pending":
            print(ui.dim("[evaluating answer]"))
        elif event == "evaluation" and isinstance(data, dict):
            score = data.get("score")
            content_text = str(data.get("content") or data.get("justification") or "")
            print()
            print(ui.bold(f"Evaluation: {score}/10"))
            print(paragraph_wrap(content_text, width=ui.width, prefix="  "))
        elif event == "evaluation_skipped" and isinstance(data, dict):
            reason = str(data.get("reason") or "Evaluation skipped.")
            print(ui.dim(f"[evaluation skipped: {reason}]"))
        elif event == "rollback" and isinstance(data, dict):
            reason = str(data.get("reason") or "Retrying.")
            retry = data.get("retry") is not False
            print(ui.yellow(f"\n[rollback: {reason}; retry={retry}]"))
        elif event == "error" and isinstance(data, dict):
            raise WaxonApiError(str(data.get("error") or "Could not continue Learn chat."))
        elif event == "done" and isinstance(data, dict):
            done_seen = True
            course = data.get("course")
            if isinstance(course, dict):
                state.course = course
                state.draft_toc = None

            chat_messages = data.get("chatMessages")
            if isinstance(chat_messages, list):
                state.chat_messages = [item for item in chat_messages if isinstance(item, dict)]
            elif assistant_text or latest_tool_calls:
                state.chat_messages.append(
                    {
                        "role": "assistant",
                        "content": assistant_text.strip(),
                        "toolCalls": latest_tool_calls,
                    }
                )

            turn_cost = data.get("turnCost")
            if isinstance(turn_cost, (int, float)) and turn_cost > 0:
                print(ui.dim(f"\n[turn cost: ${turn_cost:.6f}]"))

    client.stream_chat(
        course_id=course_id,
        content=content,
        widget_answer=widget_answer,
        on_event=on_event,
    )

    if not done_seen and (assistant_text or latest_tool_calls):
        state.chat_messages.append(
            {
                "role": "assistant",
                "content": assistant_text.strip(),
                "toolCalls": latest_tool_calls,
            }
        )

    print()
    input(ui.dim("Press Enter to continue..."))


def show_raw_prompt_preview(client: WaxonClient, ui: Ui, state: CourseState) -> None:
    if not state.course or not state.course.get("id"):
        print("Select a course before opening the raw prompt preview.")
        input(ui.dim("Press Enter to continue..."))
        return

    data = client.request_json(
        "POST",
        "/api/courses/chat/prompt-preview",
        {"courseId": state.course["id"]},
    )
    model_request = data.get("modelRequest") or data
    print(json.dumps(model_request, indent=2, ensure_ascii=False))
    input(ui.dim("Press Enter to continue..."))


def print_help(ui: Ui) -> None:
    print(ui.bold("Commands"))
    print("  /courses        choose another course")
    print("  /new [topic]    start a new course")
    print("  /raw            show the current course prompt-preview payload")
    print("  /refresh        reload the current course")
    print("  /help           show this help")
    print("  /quit           exit")
    print()
    print("For multi-line answers, press Enter on an empty prompt, then finish with '.'")
    input(ui.dim("Press Enter to continue..."))


def handle_command(
    command: str,
    *,
    client: WaxonClient,
    ui: Ui,
    state: CourseState,
    course_limit: int,
) -> bool:
    parts = command.strip().split(maxsplit=1)
    name = parts[0].lower()
    arg = parts[1] if len(parts) > 1 else ""

    if name in {"/quit", "/q", "quit"}:
        raise KeyboardInterrupt
    if name in {"/help", "help"}:
        print_help(ui)
        return True
    if name in {"/courses", "/list"}:
        selected = choose_course(client, ui, limit=course_limit, search="")
        state.course = selected
        state.chat_messages = course_chat_messages(selected)
        state.draft_toc = None
        return True
    if name == "/new":
        state.course = None
        state.chat_messages = []
        state.draft_toc = None
        if arg.strip():
            submit_turn(client, ui, state, content=arg.strip(), widget_answer=None)
        return True
    if name == "/refresh":
        if state.course and state.course.get("id"):
            refreshed = load_course(client, str(state.course["id"]))
            state.course = refreshed
            state.chat_messages = course_chat_messages(refreshed)
            state.draft_toc = None
        return True
    if name == "/raw":
        show_raw_prompt_preview(client, ui, state)
        return True

    return False


def run_tui(client: WaxonClient, ui: Ui, args: argparse.Namespace) -> None:
    state = CourseState()
    load_boot_context(client, state)

    if args.course_id:
        state.course = load_course(client, args.course_id)
        state.chat_messages = course_chat_messages(state.course)
    elif args.new:
        submit_turn(client, ui, state, content=args.new, widget_answer=None)
    else:
        selected = choose_course(client, ui, limit=args.limit, search=args.search or "")
        state.course = selected
        state.chat_messages = course_chat_messages(selected)

    while True:
        render_screen(ui, state)

        active_widget = latest_active_widget(state.chat_messages)
        if active_widget:
            answer = answer_for_widget(active_widget).strip()
            if not answer:
                continue
            if answer.startswith("/"):
                if handle_command(
                    answer,
                    client=client,
                    ui=ui,
                    state=state,
                    course_limit=args.limit,
                ):
                    continue

            widget_answer = {
                "question": active_widget.get("question"),
                "widgetId": active_widget.get("id"),
                "answer": answer,
            }
            submit_turn(client, ui, state, content=answer, widget_answer=widget_answer)
            continue

        if state.course and state.course.get("status") == "completed":
            print(ui.green("Course completed. Use /new to start another course or /quit to exit."))

        prompt = "Learning goal> " if not state.course else "Message> "
        content = read_text(prompt).strip()
        if not content:
            continue
        if content.startswith("/"):
            if handle_command(
                content,
                client=client,
                ui=ui,
                state=state,
                course_limit=args.limit,
            ):
                continue

        submit_turn(client, ui, state, content=content, widget_answer=None)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a terminal replica of Waxon's Learn flow.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("WAXON_BASE_URL", "http://localhost:3000"),
        help="Waxon app base URL.",
    )
    parser.add_argument(
        "--course-id",
        help="Resume a specific course id.",
    )
    parser.add_argument(
        "--new",
        metavar="TOPIC",
        help="Start a new course immediately with this learning goal.",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List recent courses and exit.",
    )
    parser.add_argument(
        "--search",
        default="",
        help="Search term for course listing.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=12,
        help="Number of courses to fetch in menus.",
    )
    parser.add_argument(
        "--cookie",
        default=os.environ.get("WAXON_COOKIE"),
        help="Cookie header for authenticated deployed environments.",
    )
    parser.add_argument(
        "--authorization",
        default=os.environ.get("WAXON_AUTHORIZATION"),
        help="Authorization header value, if needed.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=600.0,
        help="HTTP timeout in seconds. Learn turns can take a while.",
    )
    parser.add_argument(
        "--raw-events",
        action="store_true",
        help="Print raw SSE events as they arrive.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI color.",
    )
    parser.add_argument(
        "--history-limit",
        type=int,
        default=30,
        help="Messages to render from the end of the transcript. Use 0 for all.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    ui = Ui(
        base_url=args.base_url.rstrip("/"),
        color=(not args.no_color and sys.stdout.isatty()),
        width=terminal_width(),
        history_limit=max(0, args.history_limit),
    )
    client = WaxonClient(
        args.base_url,
        cookie=args.cookie,
        authorization=args.authorization,
        timeout=args.timeout,
        raw_events=args.raw_events,
    )

    try:
        if args.list:
            print_courses(ui, list_courses(client, limit=args.limit, search=args.search or ""))
            return 0
        run_tui(client, ui, args)
    except KeyboardInterrupt:
        print("\nBye.")
        return 0
    except WaxonApiError as error:
        print(ui.red(f"Error: {error}"), file=sys.stderr)
        print(
            "Tip: for local testing, start Waxon with `pnpm dev -- --port auto` "
            "and pass the printed URL with --base-url.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
