"""
Alert dispatch service.

Supports:
  • Discord webhook (rich embed)
  • Slack incoming webhook
  • SendGrid email

All methods are fire-and-forget; failures are logged, never raised.
No sensitive credentials are logged.
"""

from __future__ import annotations

import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

# Colour codes for Discord embeds (long = green, short = red)
_DISCORD_COLORS = {"LONG": 0x00FF88, "SHORT": 0xFF3333}


async def dispatch_signal_alert(signal_data: dict) -> None:
    """
    Send all configured alerts for a new signal.

    `signal_data` keys: instrument, direction, setup_type, grade, score,
    entry_price, sl_price, tp1_price, tp2_price, tp3_price, tp4_price,
    signal_time (ISO string).
    """
    tasks = []

    if settings.discord_webhook_url:
        await _send_discord(signal_data)

    if settings.slack_webhook_url:
        await _send_slack(signal_data)

    if settings.sendgrid_api_key and settings.alert_email_to:
        _send_email_sendgrid(signal_data)


async def _send_discord(data: dict) -> None:
    direction = data.get("direction", "LONG")
    instrument = data.get("instrument", "")
    grade = data.get("grade", "")
    score = data.get("score", 0)
    setup = data.get("setup_type", "")
    entry = data.get("entry_price", 0)
    sl = data.get("sl_price", 0)
    tp1 = data.get("tp1_price", 0)
    tp2 = data.get("tp2_price", 0)
    tp3 = data.get("tp3_price", 0)
    tp4 = data.get("tp4_price", 0)

    emoji = "🟢" if direction == "LONG" else "🔴"
    arrow = "▲" if direction == "LONG" else "▼"

    embed = {
        "title": f"{emoji} {instrument} {direction} Signal — Grade {grade}",
        "color": _DISCORD_COLORS.get(direction, 0xAAAAAA),
        "fields": [
            {"name": "Setup", "value": setup, "inline": True},
            {"name": "Score", "value": f"{score}/100", "inline": True},
            {"name": "Entry", "value": f"{entry:.2f}", "inline": True},
            {"name": "Stop Loss", "value": f"{sl:.2f}", "inline": True},
            {"name": "TP1", "value": f"{tp1:.2f}", "inline": True},
            {"name": "TP2", "value": f"{tp2:.2f}", "inline": True},
            {"name": "TP3", "value": f"{tp3:.2f}", "inline": True},
            {"name": "TP4", "value": f"{tp4:.2f}", "inline": True},
        ],
        "footer": {"text": f"NQ Signal Pro • {data.get('signal_time', '')}"},
        "timestamp": data.get("signal_time"),
    }

    payload = {"username": "NQ Signal Pro", "embeds": [embed]}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(settings.discord_webhook_url, json=payload)
            resp.raise_for_status()
            logger.info("Discord alert sent for %s %s", instrument, direction)
    except Exception as exc:
        logger.warning("Discord alert failed: %s", exc)


async def _send_slack(data: dict) -> None:
    direction = data.get("direction", "LONG")
    instrument = data.get("instrument", "")
    grade = data.get("grade", "")
    score = data.get("score", 0)
    entry = data.get("entry_price", 0)
    sl = data.get("sl_price", 0)
    tp1 = data.get("tp1_price", 0)

    emoji = ":large_green_circle:" if direction == "LONG" else ":red_circle:"

    text = (
        f"{emoji} *{instrument} {direction}* — Grade *{grade}* ({score}/100)\n"
        f"Entry: `{entry:.2f}`  SL: `{sl:.2f}`  TP1: `{tp1:.2f}`"
    )

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(settings.slack_webhook_url, json={"text": text})
            resp.raise_for_status()
            logger.info("Slack alert sent for %s %s", instrument, direction)
    except Exception as exc:
        logger.warning("Slack alert failed: %s", exc)


def _send_email_sendgrid(data: dict) -> None:
    direction = data.get("direction", "LONG")
    instrument = data.get("instrument", "")
    grade = data.get("grade", "")
    entry = data.get("entry_price", 0)
    sl = data.get("sl_price", 0)
    tp1 = data.get("tp1_price", 0)
    tp2 = data.get("tp2_price", 0)
    tp3 = data.get("tp3_price", 0)
    score = data.get("score", 0)
    setup = data.get("setup_type", "")

    subject = f"[{grade}] {instrument} {direction} Signal — Entry {entry:.2f}"
    body_html = f"""
    <html><body style="font-family: monospace; background: #0a0a1e; color: #eee; padding: 20px;">
    <h2 style="color: {'#00ff88' if direction == 'LONG' else '#ff4444'}">
        {'▲' if direction == 'LONG' else '▼'} {instrument} {direction} — Grade {grade}
    </h2>
    <table>
        <tr><td>Setup</td><td><b>{setup}</b></td></tr>
        <tr><td>Score</td><td>{score}/100</td></tr>
        <tr><td>Entry</td><td>{entry:.2f}</td></tr>
        <tr><td>Stop Loss</td><td style="color:#ff4444">{sl:.2f}</td></tr>
        <tr><td>TP1</td><td style="color:#00ff88">{tp1:.2f}</td></tr>
        <tr><td>TP2</td><td style="color:#40c4ff">{tp2:.2f}</td></tr>
        <tr><td>TP3</td><td style="color:#ce93d8">{tp3:.2f}</td></tr>
    </table>
    <p style="color:#666; font-size:11px; margin-top:20px;">
        ⚠️ This is a paper trading signal. Not financial advice. Futures trading involves substantial risk.
    </p>
    </body></html>
    """

    try:
        import sendgrid
        from sendgrid.helpers.mail import Mail, Email, To, Content

        sg = sendgrid.SendGridAPIClient(api_key=settings.sendgrid_api_key)
        message = Mail(
            from_email=settings.alert_email_from,
            to_emails=settings.alert_email_to,
            subject=subject,
            html_content=body_html,
        )
        sg.send(message)
        logger.info("Email alert sent to %s", settings.alert_email_to)
    except ImportError:
        logger.warning("sendgrid package not installed — skipping email alert")
    except Exception as exc:
        logger.warning("Email alert failed: %s", exc)
