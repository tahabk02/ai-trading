import logging

import pytest

from pocket_bridge.config import BridgeSettings, mask_uid
from pocket_bridge.main import logger


def test_ssid_present_log(caplog):
    settings = BridgeSettings(
        ssid=(
            '42["auth",{"session":"session-value","uid":123,'
            '"isDemo":1,"isOptimized":true}]'
        )
    )

    with caplog.at_level(logging.INFO, logger=logger.name):
        logger.info(
            "SSID loaded: format=%s length=%d uid=%s isDemo=%s isOptimized=%s",
            settings.ssid_format,
            len(settings.ssid),
            mask_uid(settings.uid),
            settings.is_demo,
            settings.auth.get("isOptimized", False),
        )

    assert "SSID loaded: format=full" in caplog.text
    assert f"length={len(settings.ssid)}" in caplog.text
    # PART 44 [499] — the account id is MASKED, never logged in full.
    assert "uid=123*" in caplog.text
    assert "uid=123 " not in caplog.text
    assert "isDemo=1" in caplog.text
    assert "isOptimized=True" in caplog.text


@pytest.mark.parametrize(
    "raw,expected",
    [
        (138336943, "138******"),
        ("138336943", "138******"),
        (123, "123*"),
        (7, "7*"),
        (0, "0*"),
        ("", "(empty)"),
        (None, "(empty)"),
        ("  ", "(empty)"),
    ],
)
def test_mask_uid_never_reveals_full_id(raw, expected):
    masked = mask_uid(raw)
    assert masked == expected
    full = str(raw if raw is not None else "").strip()
    if full and len(full) > 3:
        # Everything past the first three digits is redacted.
        assert full[3:] not in masked
        assert masked.startswith(full[:3])
