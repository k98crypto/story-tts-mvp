import json
import os
import sqlite3
import threading
from http.cookies import SimpleCookie
from datetime import datetime, timezone
from http.client import HTTPConnection
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_PUBLISHABLE_KEY = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")
ADMIN_EMAILS = {
    email.strip().casefold()
    for email in os.environ.get("ADMIN_EMAILS", "").split(",")
    if email.strip()
}
DAILY_CHARACTER_LIMIT = max(0, int(os.environ.get("DAILY_CHARACTER_LIMIT", "3000")))
USAGE_DB = os.environ.get("USAGE_DB", "/data/usage.sqlite3")
AUTH_READY = bool(SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY)
SYNTHESIS_SLOTS = threading.BoundedSemaphore(2)
MAX_DAILY_CHARACTER_LIMIT = 1_000_000
SESSION_COOKIE_NAME = "spiritwave_refresh"
SESSION_COOKIE_MAX_AGE = 7 * 24 * 60 * 60


def ensure_usage_db():
    os.makedirs(os.path.dirname(USAGE_DB), exist_ok=True)
    with sqlite3.connect(USAGE_DB) as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS daily_usage ("
            "user_id TEXT NOT NULL, day TEXT NOT NULL, characters INTEGER NOT NULL, "
            "PRIMARY KEY (user_id, day))"
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS blocked_users ("
            "user_id TEXT PRIMARY KEY, blocked_at TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '')"
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        connection.execute(
            "INSERT OR IGNORE INTO app_settings(key, value) VALUES ('daily_character_limit', ?)",
            (str(DAILY_CHARACTER_LIMIT),),
        )
        today = datetime.now(timezone.utc).date().isoformat()
        connection.execute("DELETE FROM daily_usage WHERE day < ?", (today,))


def is_admin(user):
    return user.get("email", "").strip().casefold() in ADMIN_EMAILS


def get_daily_character_limit(connection=None):
    if connection is None:
        with sqlite3.connect(USAGE_DB, timeout=5) as connection:
            return get_daily_character_limit(connection)
    row = connection.execute(
        "SELECT value FROM app_settings WHERE key = 'daily_character_limit'"
    ).fetchone()
    return max(0, int(row[0])) if row else DAILY_CHARACTER_LIMIT


def is_user_blocked(user_id):
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        return connection.execute(
            "SELECT 1 FROM blocked_users WHERE user_id = ?", (user_id,)
        ).fetchone() is not None


def reserve_characters(user_id, count):
    day = datetime.now(timezone.utc).date().isoformat()
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        daily_limit = get_daily_character_limit(connection)
        if count > daily_limit:
            return False
        cursor = connection.execute(
            "INSERT INTO daily_usage(user_id, day, characters) VALUES (?, ?, ?) "
            "ON CONFLICT(user_id, day) DO UPDATE SET characters = characters + excluded.characters "
            "WHERE daily_usage.characters + excluded.characters <= ?",
            (user_id, day, count, daily_limit),
        )
        return cursor.rowcount == 1


def set_daily_character_limit(value):
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        connection.execute(
            "INSERT INTO app_settings(key, value) VALUES ('daily_character_limit', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(value),),
        )


def get_usage_overview():
    today = datetime.now(timezone.utc).date().isoformat()
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        today_characters, active_users = connection.execute(
            "SELECT COALESCE(SUM(characters), 0), COUNT(DISTINCT user_id) "
            "FROM daily_usage WHERE day = ?", (today,)
        ).fetchone()
        known_users = connection.execute(
            "SELECT COUNT(DISTINCT user_id) FROM daily_usage"
        ).fetchone()[0]
        blocked_users = connection.execute("SELECT COUNT(*) FROM blocked_users").fetchone()[0]
        daily_limit = get_daily_character_limit(connection)
    return {
        "date": today,
        "dailyCharacterLimit": daily_limit,
        "todayCharacters": today_characters,
        "activeUsersToday": active_users,
        "knownUsers": known_users,
        "blockedUsers": blocked_users,
    }


def list_usage_users():
    today = datetime.now(timezone.utc).date().isoformat()
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            "SELECT usage.user_id, SUM(usage.characters) AS total_characters, "
            "SUM(CASE WHEN usage.day = ? THEN usage.characters ELSE 0 END) AS today_characters, "
            "MAX(usage.day) AS last_active_day, blocked.user_id IS NOT NULL AS blocked "
            "FROM daily_usage AS usage LEFT JOIN blocked_users AS blocked "
            "ON blocked.user_id = usage.user_id GROUP BY usage.user_id "
            "ORDER BY today_characters DESC, total_characters DESC LIMIT 500",
            (today,),
        ).fetchall()
    return [dict(row) for row in rows]


def set_user_blocked(user_id, blocked, reason=""):
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        if blocked:
            connection.execute(
                "INSERT INTO blocked_users(user_id, blocked_at, reason) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET blocked_at = excluded.blocked_at, reason = excluded.reason",
                (user_id, datetime.now(timezone.utc).isoformat(), reason[:200]),
            )
        else:
            connection.execute("DELETE FROM blocked_users WHERE user_id = ?", (user_id,))


def read_json_body(handler, max_length=8_000):
    length = int(handler.headers.get("Content-Length", "0"))
    if length < 1 or length > max_length:
        raise ValueError("request body size is invalid")
    return json.loads(handler.rfile.read(length))


def refresh_supabase_session(refresh_token):
    payload = json.dumps({"refresh_token": refresh_token}).encode("utf-8")
    request = Request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
        data=payload,
        headers={
            "apikey": SUPABASE_PUBLISHABLE_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=8) as response:
            session = json.loads(response.read())
        if not session.get("access_token") or not session.get("refresh_token"):
            return None, 401
        return session, None
    except HTTPError as error:
        return None, 401 if error.code in (400, 401, 403) else 503
    except (URLError, TimeoutError, OSError, json.JSONDecodeError):
        return None, 503


def user_id_from_admin_path(path):
    parts = path.strip("/").split("/")
    if len(parts) != 5 or parts[:3] != ["admin", "api", "users"]:
        return None, None
    user_id = unquote(parts[3])
    if not user_id or len(user_id) > 64 or parts[4] not in ("block", "unblock"):
        return None, None
    return user_id, parts[4]


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".webp": "image/webp"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory="/srv", **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/config":
            self.send_json(200, {
                "authReady": AUTH_READY,
                "supabaseUrl": SUPABASE_URL if AUTH_READY else "",
                "publishableKey": SUPABASE_PUBLISHABLE_KEY if AUTH_READY else "",
            })
        elif path == "/session":
            user, error = self.authenticate()
            if error:
                self.send_json(error[0], {"error": error[1]})
            else:
                email = user.get("email", "")
                self.send_json(200, {
                    "id": user["id"],
                    "email": email,
                    "isAdmin": is_admin(user),
                    "accessToken": self.session_access_token,
                })
        elif path == "/admin":
            self.path = "/admin.html"
            super().do_GET()
        elif path.startswith("/admin/api/"):
            user, error = self.require_admin()
            if error:
                self.send_json(error[0], {"error": error[1]})
            elif path == "/admin/api/overview":
                self.send_json(200, get_usage_overview())
            elif path == "/admin/api/users":
                self.send_json(200, {"users": list_usage_users()})
            else:
                self.send_error(404)
        elif path == "/health":
            self.proxy_to_tts()
        else:
            super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        if path == "/auth/remember":
            try:
                payload = read_json_body(self)
            except (ValueError, json.JSONDecodeError):
                self.send_json(400, {"error": "invalid remember-session request"})
                return
            remember = payload.get("remember") if isinstance(payload, dict) else None
            if not isinstance(remember, bool):
                self.send_json(400, {"error": "remember must be a boolean"})
                return
            if not remember:
                self.set_session_cookie("")
                self.send_json(200, {"remembered": False})
                return

            user, error = self.authenticate()
            if error:
                self.send_json(error[0], {"error": error[1]})
                return
            refresh_token = payload.get("refreshToken")
            if not isinstance(refresh_token, str) or not refresh_token or len(refresh_token) > 4096:
                self.send_json(400, {"error": "invalid refresh token"})
                return
            session, refresh_error = refresh_supabase_session(refresh_token)
            session_user = session.get("user", {}) if session else {}
            if refresh_error or session_user.get("id") != user.get("id"):
                if refresh_error == 503:
                    self.send_json(503, {"error": "account service is temporarily unavailable"})
                else:
                    self.set_session_cookie("")
                    self.send_json(401, {"error": "session could not be remembered"})
                return
            self.session_access_token = session["access_token"]
            self.set_session_cookie(session["refresh_token"])
            self.send_json(200, {"remembered": True, "accessToken": self.session_access_token})
            return

        if path.startswith("/admin/api/"):
            user, error = self.require_admin()
            if error:
                self.send_json(error[0], {"error": error[1]})
                return
            if path == "/admin/api/settings/daily-limit":
                try:
                    payload = read_json_body(self)
                    value = payload.get("dailyCharacterLimit") if isinstance(payload, dict) else None
                    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= MAX_DAILY_CHARACTER_LIMIT:
                        raise ValueError("dailyCharacterLimit must be between 0 and 1000000")
                    set_daily_character_limit(value)
                    self.send_json(200, {"dailyCharacterLimit": value})
                except (ValueError, json.JSONDecodeError):
                    self.send_json(400, {"error": "invalid daily character limit"})
                return

            target_user_id, action = user_id_from_admin_path(path)
            if target_user_id and action:
                if target_user_id == user["id"]:
                    self.send_json(400, {"error": "cannot change your own synthesis access"})
                    return
                reason = ""
                if action == "block":
                    try:
                        payload = read_json_body(self)
                        reason = payload.get("reason", "") if isinstance(payload, dict) else ""
                        if not isinstance(reason, str):
                            raise ValueError("invalid reason")
                    except (ValueError, json.JSONDecodeError):
                        self.send_json(400, {"error": "invalid block reason"})
                        return
                set_user_blocked(target_user_id, action == "block", reason)
                self.send_json(200, {"userId": target_user_id, "blocked": action == "block"})
                return
            self.send_error(404)
            return

        if path != "/synthesize":
            self.send_error(404)
            return

        user, error = self.authenticate()
        if error:
            self.send_json(error[0], {"error": error[1]})
            return
        if is_user_blocked(user["id"]):
            self.send_json(403, {"error": "synthesis access is disabled for this account"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 24_000:
                self.send_json(413, {"error": "request body too large"})
                return
            body = self.rfile.read(length)
            payload = json.loads(body)
            text = payload.get("text") if isinstance(payload, dict) else None
            if not isinstance(text, str) or not text.strip():
                self.send_json(400, {"error": "text is required"})
                return
            character_count = len(text.strip())
            if character_count > 1200:
                self.send_json(422, {"error": "text exceeds 1200 characters"})
                return
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "invalid JSON request"})
            return

        if not SYNTHESIS_SLOTS.acquire(timeout=1):
            self.send_json(429, {"error": "synthesis queue is full"}, {"Retry-After": "3"})
            return
        try:
            if not reserve_characters(user["id"], character_count):
                self.send_json(429, {
                    "error": "daily character limit reached",
                    "dailyCharacterLimit": get_daily_character_limit(),
                })
                return
            self.proxy_to_tts(body)
        finally:
            SYNTHESIS_SLOTS.release()

    def authenticate(self):
        if not AUTH_READY:
            return None, (503, "account service is not configured")
        authorization = self.headers.get("Authorization", "")
        access_token = authorization[7:] if authorization.startswith("Bearer ") else ""
        if not access_token:
            cookies = SimpleCookie(self.headers.get("Cookie", ""))
            morsel = cookies.get(SESSION_COOKIE_NAME)
            if not morsel or not morsel.value:
                return None, (401, "sign in required")
            session, refresh_error = refresh_supabase_session(morsel.value)
            if refresh_error:
                if refresh_error == 401:
                    self.set_session_cookie("")
                    return None, (401, "remembered session expired")
                return None, (503, "account service is temporarily unavailable")
            access_token = session["access_token"]
            self.set_session_cookie(session["refresh_token"])
        self.session_access_token = access_token
        request = Request(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": SUPABASE_PUBLISHABLE_KEY,
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=8) as response:
                user = json.loads(response.read())
            if not user.get("id") or not user.get("email"):
                return None, (401, "verified account required")
            if user.get("email_confirmed_at") is None:
                return None, (403, "confirm your email before using synthesis")
            return user, None
        except HTTPError as error:
            if error.code in (401, 403):
                return None, (401, "session is invalid or expired")
            return None, (503, "account service is temporarily unavailable")
        except (URLError, TimeoutError, OSError, json.JSONDecodeError):
            return None, (503, "account service is temporarily unavailable")

    def set_session_cookie(self, refresh_token):
        cookies = SimpleCookie()
        cookies[SESSION_COOKIE_NAME] = refresh_token
        cookie = cookies[SESSION_COOKIE_NAME]
        cookie["path"] = "/"
        cookie["httponly"] = True
        cookie["secure"] = True
        cookie["samesite"] = "Lax"
        cookie["max-age"] = SESSION_COOKIE_MAX_AGE if refresh_token else 0
        self.session_cookie_header = cookie.OutputString()

    def require_admin(self):
        user, error = self.authenticate()
        if error:
            return None, error
        if not is_admin(user):
            return None, (403, "administrator access required")
        return user, None

    def proxy_to_tts(self, body=None):
        headers = {}
        content_type = self.headers.get("Content-Type")
        if content_type:
            headers["Content-Type"] = content_type
        upstream = HTTPConnection("host.docker.internal", 8766, timeout=300)
        try:
            upstream.request(self.command, self.path, body=body, headers=headers)
            response = upstream.getresponse()
            payload = response.read()
            self.send_response(response.status)
            self.send_header("Content-Type", response.getheader("Content-Type", "application/octet-stream"))
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", response.getheader("Cache-Control", "no-store"))
            self.end_headers()
            self.wfile.write(payload)
        except OSError:
            self.send_json(502, {"error": "TTS service is temporarily unavailable"})
        finally:
            upstream.close()

    def send_json(self, status, value, extra_headers=None):
        payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "session_cookie_header", None):
            self.send_header("Set-Cookie", self.session_cookie_header)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    ensure_usage_db()
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
