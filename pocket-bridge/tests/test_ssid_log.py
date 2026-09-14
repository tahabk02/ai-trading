import logging

from pocket_bridge.config import BridgeSettings
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
            settings.uid,
            settings.is_demo,
            settings.auth.get("isOptimized", False),
        )

    assert "SSID loaded: format=full" in caplog.text
    assert f"length={len(settings.ssid)}" in caplog.text
    assert "uid=123" in caplog.text
    assert "isDemo=1" in caplog.text
    assert "isOptimized=True" in caplog.text