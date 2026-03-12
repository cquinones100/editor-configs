#!/usr/bin/env python3

import os
import subprocess
import hashlib

import iterm2


def get_title(cwd):
    if not cwd:
        return ""

    dirname = os.path.basename(cwd)

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=2,
        )
        if result.returncode != 0:
            return dirname

        git_common_dir = os.path.realpath(
            os.path.join(cwd, result.stdout.strip())
        )
        git_dir_result = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=2,
        )
        git_dir = os.path.realpath(
            os.path.join(cwd, git_dir_result.stdout.strip())
        )

        if git_dir != git_common_dir:
            worktree_name = os.path.basename(git_dir)
            return f"{dirname} | worktree:{worktree_name}"

        branch_result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=2,
        )
        if branch_result.returncode == 0:
            branch = branch_result.stdout.strip()
            return f"{dirname} | branch:{branch}"

        return dirname
    except Exception:
        return dirname


def get_tab_color(cwd):
    if not cwd:
        return iterm2.Color(128, 128, 128)

    hue = int.from_bytes(hashlib.sha256(cwd.encode()).digest()[:4], "big") % 360
    h_segment = hue // 60
    h_frac = (hue % 60) * 255 // 60
    c = 204
    diff = abs(h_frac * 2 - 255)
    x = c * (255 - diff) // 255
    m = 35

    if h_segment == 0:
        r, g, b = c + m, x + m, m
    elif h_segment == 1:
        r, g, b = x + m, c + m, m
    elif h_segment == 2:
        r, g, b = m, c + m, x + m
    elif h_segment == 3:
        r, g, b = m, x + m, c + m
    elif h_segment == 4:
        r, g, b = x + m, m, c + m
    else:
        r, g, b = c + m, m, x + m

    r = max(0, min(255, r))
    g = max(0, min(255, g))
    b = max(0, min(255, b))

    return iterm2.Color(r, g, b)


async def update_tab_color(app, session_id, path):
    session = app.get_session_by_id(session_id)
    if not session:
        return
    color = get_tab_color(path)
    profile = await session.async_get_profile()
    await profile.async_set_use_tab_color(True)
    await profile.async_set_tab_color(color)


async def monitor_session(connection, session_id):
    app = await iterm2.async_get_app(connection)
    session = app.get_session_by_id(session_id)
    if session:
        path = await session.async_get_variable("path")
        await update_tab_color(app, session_id, path)

    async with iterm2.VariableMonitor(
        connection, iterm2.VariableScopes.SESSION, "path", session_id
    ) as mon:
        while True:
            new_value = await mon.async_get()
            await update_tab_color(app, session_id, new_value)


async def main(connection):
    app = await iterm2.async_get_app(connection)

    @iterm2.TitleProviderRPC
    async def session_title(path=iterm2.Reference("path?")):
        return get_title(path)

    await session_title.async_register(
        connection,
        display_name="Directory + Worktree/Branch",
        unique_identifier="com.cquinones.session-title",
    )

    await iterm2.EachSessionOnceMonitor.async_foreach_session_create_task(
        app, lambda session_id: monitor_session(connection, session_id)
    )


iterm2.run_forever(main)
