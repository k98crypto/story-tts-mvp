import json
import hashlib
import hmac
import ipaddress
import os
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from http.client import HTTPConnection
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
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
YAF_HOST = "yaf.spiritwave.dpdns.org"
YAF_LOCAL_HOST = "192.168.10.10"
HOME_NETWORK = ipaddress.ip_network("192.168.10.0/24")
PASSWORD_ITERATIONS = 310_000
LOCAL_SESSION_DAYS = 30
SIGNUPS_PER_IP_PER_DAY = 5
LOGIN_FAILURE_LIMIT = 8
LOGIN_LOCK_SECONDS = 900
YAF_STATIC_PATHS = {
    "/",
    "/index.html",
    "/app.css",
    "/app.js",
    "/service-worker.js",
    "/manifest.webmanifest",
    "/vendor/zip.min.js",
    "/assets/bookmark.svg",
    "/assets/cover.webp",
}


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
            "CREATE TABLE IF NOT EXISTS local_users ("
            "user_id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, "
            "password_salt BLOB NOT NULL, password_hash BLOB NOT NULL, created_at TEXT NOT NULL)"
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS local_sessions ("
            "token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, "
            "created_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES local_users(user_id) ON DELETE CASCADE)"
        )
        connection.execute("CREATE INDEX IF NOT EXISTS local_sessions_user ON local_sessions(user_id)")
        connection.execute(
            "CREATE TABLE IF NOT EXISTS signup_attempts ("
            "source_hash TEXT NOT NULL, day TEXT NOT NULL, attempts INTEGER NOT NULL, "
            "PRIMARY KEY(source_hash, day))"
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS login_attempts ("
            "source_hash TEXT NOT NULL, email_hash TEXT NOT NULL, window_start INTEGER NOT NULL, "
            "failures INTEGER NOT NULL, PRIMARY KEY(source_hash, email_hash))"
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
            "SELECT COUNT(DISTINCT user_id) FROM ("
            "SELECT user_id FROM daily_usage UNION SELECT user_id FROM local_users)"
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
            "WITH all_users AS (SELECT user_id FROM daily_usage UNION SELECT user_id FROM local_users), "
            "usage_stats AS (SELECT user_id, SUM(characters) AS total_characters, "
            "SUM(CASE WHEN day = ? THEN characters ELSE 0 END) AS today_characters, MAX(day) AS last_active_day "
            "FROM daily_usage GROUP BY user_id) "
            "SELECT all_users.user_id, local_users.email, "
            "COALESCE(usage_stats.total_characters, 0) AS total_characters, "
            "COALESCE(usage_stats.today_characters, 0) AS today_characters, "
            "usage_stats.last_active_day, blocked.user_id IS NOT NULL AS blocked "
            "FROM all_users LEFT JOIN usage_stats ON usage_stats.user_id = all_users.user_id "
            "LEFT JOIN local_users ON local_users.user_id = all_users.user_id "
            "LEFT JOIN blocked_users AS blocked ON blocked.user_id = all_users.user_id "
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


def normalize_email(value):
    if not isinstance(value, str):
        raise ValueError("email is required")
    email = value.strip().casefold()
    if len(email) > 254 or email.count("@") != 1 or any(char.isspace() for char in email):
        raise ValueError("enter a valid email address")
    local, domain = email.split("@", 1)
    if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
        raise ValueError("enter a valid email address")
    return email


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)


def source_address(handler):
    peer = handler.client_address[0].split("%", 1)[0]
    try:
        peer_ip = ipaddress.ip_address(peer)
        forwarded = handler.headers.get("CF-Connecting-IP", "").strip()
        if (peer_ip.is_private or peer_ip.is_loopback) and forwarded:
            try:
                return str(ipaddress.ip_address(forwarded))
            except ValueError:
                pass
        return str(peer_ip)
    except ValueError:
        return peer[:64]


def source_hash(address):
    return hashlib.sha256(address.encode("utf-8")).hexdigest()


def is_home_lan_peer(handler):
    try:
        peer_ip = ipaddress.ip_address(handler.client_address[0].split("%", 1)[0])
        if peer_ip in HOME_NETWORK:
            return True
        host = handler.headers.get("Host", "").partition(":")[0].rstrip(".").lower()
        origin = urlsplit(handler.headers.get("Origin", ""))
        return (
            peer_ip.is_private
            and host == YAF_LOCAL_HOST
            and origin.scheme == "http"
            and origin.hostname == YAF_LOCAL_HOST
            and origin.port == 8765
        )
    except ValueError:
        return False


def record_signup_attempt(address):
    day = datetime.now(timezone.utc).date().isoformat()
    source = source_hash(address)
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        connection.execute(
            "INSERT INTO signup_attempts(source_hash, day, attempts) VALUES (?, ?, 1) "
            "ON CONFLICT(source_hash, day) DO UPDATE SET attempts = attempts + 1",
            (source, day),
        )
        attempts = connection.execute(
            "SELECT attempts FROM signup_attempts WHERE source_hash = ? AND day = ?",
            (source, day),
        ).fetchone()[0]
    return attempts <= SIGNUPS_PER_IP_PER_DAY


def login_is_limited(address, email):
    now = int(time.time())
    source = source_hash(address)
    email_key = hashlib.sha256(email.encode("utf-8")).hexdigest()
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        row = connection.execute(
            "SELECT window_start, failures FROM login_attempts WHERE source_hash = ? AND email_hash = ?",
            (source, email_key),
        ).fetchone()
        if not row or now - row[0] >= LOGIN_LOCK_SECONDS:
            return False
        return row[1] >= LOGIN_FAILURE_LIMIT


def record_login_failure(address, email):
    now = int(time.time())
    source = source_hash(address)
    email_key = hashlib.sha256(email.encode("utf-8")).hexdigest()
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        connection.execute(
            "INSERT INTO login_attempts(source_hash, email_hash, window_start, failures) VALUES (?, ?, ?, 1) "
            "ON CONFLICT(source_hash, email_hash) DO UPDATE SET "
            "window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END, "
            "failures = CASE WHEN ? - window_start >= ? THEN 1 ELSE failures + 1 END",
            (source, email_key, now, now, LOGIN_LOCK_SECONDS, now, now, LOGIN_LOCK_SECONDS),
        )


def clear_login_failures(address, email):
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        connection.execute(
            "DELETE FROM login_attempts WHERE source_hash = ? AND email_hash = ?",
            (source_hash(address), hashlib.sha256(email.encode("utf-8")).hexdigest()),
        )


def create_local_session(user_id):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    now = int(time.time())
    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
        connection.execute("DELETE FROM local_sessions WHERE expires_at <= ?", (now,))
        connection.execute(
            "INSERT INTO local_sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (token_hash, user_id, now + LOCAL_SESSION_DAYS * 86400, datetime.now(timezone.utc).isoformat()),
        )
    return token


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

    def is_yaf_host(self):
        host = self.headers.get("Host", "").partition(":")[0].rstrip(".").lower()
        return host in {YAF_HOST, YAF_LOCAL_HOST}

    def do_GET(self):
        path = urlsplit(self.path).path
        yaf_host = self.is_yaf_host()
        if yaf_host and path.startswith("/admin"):
            self.send_error(404)
            return
        if path == "/config":
            if yaf_host:
                self.send_json(200, {"authReady": True, "localAuth": True, "adminSetupOnLan": True})
            else:
                self.send_json(200, {
                    "authReady": AUTH_READY,
                    "supabaseUrl": SUPABASE_URL if AUTH_READY else "",
                    "publishableKey": SUPABASE_PUBLISHABLE_KEY if AUTH_READY else "",
                })
        elif path == "/session":
            user, error = self.authenticate_local() if yaf_host else self.authenticate()
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
            if yaf_host:
                if path not in YAF_STATIC_PATHS:
                    self.send_error(404)
                    return
                self.directory = "/srv/yaf"
            super().do_GET()

    def do_HEAD(self):
        path = urlsplit(self.path).path
        if self.is_yaf_host():
            if path not in YAF_STATIC_PATHS:
                self.send_error(404)
                return
            self.directory = "/srv/yaf"
        super().do_HEAD()

    def do_POST(self):
        path = urlsplit(self.path).path
        if self.is_yaf_host() and path.startswith("/admin"):
            self.send_error(404)
            return
        if path.startswith("/auth/local/"):
            if not self.is_yaf_host():
                self.send_error(404)
                return
            try:
                payload = read_json_body(self)
                email = normalize_email(payload.get("email") if isinstance(payload, dict) else None)
                password = payload.get("password") if isinstance(payload, dict) else None
                if not isinstance(password, str) or len(password) < 8 or len(password) > 256:
                    raise ValueError("password must be between 8 and 256 characters")
            except (ValueError, json.JSONDecodeError):
                self.send_json(400, {"error": "enter a valid email and a password of at least 8 characters"})
                return

            address = source_address(self)
            if path == "/auth/local/signup":
                if email in ADMIN_EMAILS and not is_home_lan_peer(self):
                    self.send_json(403, {"error": "create the administrator account from the home Wi-Fi network"})
                    return
                if not record_signup_attempt(address):
                    self.send_json(429, {"error": "too many account registrations from this network today"})
                    return
                salt = secrets.token_bytes(16)
                user_id = str(uuid.uuid4())
                try:
                    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
                        connection.execute(
                            "INSERT INTO local_users(user_id, email, password_salt, password_hash, created_at) "
                            "VALUES (?, ?, ?, ?, ?)",
                            (user_id, email, salt, password_hash(password, salt), datetime.now(timezone.utc).isoformat()),
                        )
                except sqlite3.IntegrityError:
                    self.send_json(409, {"error": "an account with this email already exists"})
                    return
                token = create_local_session(user_id)
                self.send_json(201, {"accessToken": token, "user": {"id": user_id, "email": email}})
                return

            if path == "/auth/local/login":
                if login_is_limited(address, email):
                    self.send_json(429, {"error": "too many failed attempts; try again in 15 minutes"})
                    return
                with sqlite3.connect(USAGE_DB, timeout=5) as connection:
                    connection.row_factory = sqlite3.Row
                    user = connection.execute(
                        "SELECT user_id, email, password_salt, password_hash FROM local_users WHERE email = ?",
                        (email,),
                    ).fetchone()
                salt = bytes(user["password_salt"]) if user else b"yaf-local-auth-dummy"
                expected = bytes(user["password_hash"]) if user else b"\x00" * 32
                valid = hmac.compare_digest(password_hash(password, salt), expected) and user is not None
                if not valid:
                    record_login_failure(address, email)
                    self.send_json(401, {"error": "invalid email or password"})
                    return
                clear_login_failures(address, email)
                token = create_local_session(user["user_id"])
                self.send_json(200, {"accessToken": token, "user": {"id": user["user_id"], "email": user["email"]}})
                return

            if path == "/auth/local/logout":
                token = self.bearer_token()
                if token:
                    with sqlite3.connect(USAGE_DB, timeout=5) as connection:
                        connection.execute(
                            "DELETE FROM local_sessions WHERE token_hash = ?",
                            (hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest(),),
                        )
                self.send_json(200, {"signedOut": True})
                return

            self.send_error(404)
            return

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

        user, error = self.authenticate_local() if self.is_yaf_host() else self.authenticate()
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

    def bearer_token(self):
        authorization = self.headers.get("Authorization", "")
        token = authorization[7:] if authorization.startswith("Bearer ") else ""
        return token if 1 <= len(token) <= 256 else ""

    def authenticate_local(self):
        token = self.bearer_token()
        if not token:
            return None, (401, "sign in required")
        token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
        now = int(time.time())
        with sqlite3.connect(USAGE_DB, timeout=5) as connection:
            connection.row_factory = sqlite3.Row
            row = connection.execute(
                "SELECT users.user_id, users.email, sessions.expires_at "
                "FROM local_sessions AS sessions JOIN local_users AS users "
                "ON users.user_id = sessions.user_id WHERE sessions.token_hash = ?",
                (token_hash,),
            ).fetchone()
            if row and row["expires_at"] <= now:
                connection.execute("DELETE FROM local_sessions WHERE token_hash = ?", (token_hash,))
                row = None
        if not row:
            return None, (401, "session is invalid or expired")
        self.session_access_token = token
        return {"id": row["user_id"], "email": row["email"]}, None

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
