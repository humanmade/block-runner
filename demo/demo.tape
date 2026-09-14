# Block Runner README demo rendered with VHS (https://github.com/charmbracelet/vhs)
# A scripted Claude Code session showing the registered-block path: preview,
# confirm, then write a reusable block into the plugin. demo.sh simulates the
# typing itself, character by character, so the command is already coloured
# while it appears rather than being redrawn after Enter.

# Emits demo/demo.hq.gif (README, autoplays on GitHub) + demo/demo.mp4 (Slack/socials, plays reliably).
# For max GIF compatibility (Slack transcodes GIFs and can show a static frame), the
# shipped demo.gif is re-encoded from the mp4 with a clean ffmpeg palette:
#   ffmpeg -i demo/demo.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/pal.png
#   ffmpeg -i demo/demo.mp4 -i /tmp/pal.png -lavfi "fps=15,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a" /tmp/clean.gif
#   gifsicle -O3 --careful /tmp/clean.gif -o demo/demo.gif
Output demo/demo.hq.gif
Output demo/demo.mp4

Set Shell bash
Set FontSize 20
Set Width 1400
Set Height 640
Set Padding 24
Set Margin 28
Set MarginFill "#07080d"
Set BorderRadius 12
Set WindowBar Colorful
Set Theme { "background": "#0c0c0e", "foreground": "#e7e9ee", "cursor": "#d97757", "selection": "#2a2f44", "black": "#0c0c0e", "red": "#f87171", "green": "#5fd38d", "yellow": "#d97757", "blue": "#8b8f98", "magenta": "#d97757", "cyan": "#8b8f98", "white": "#e7e9ee", "brightBlack": "#8b8f98", "brightRed": "#f87171", "brightGreen": "#5fd38d", "brightYellow": "#d97757", "brightBlue": "#8b8f98", "brightMagenta": "#d97757", "brightCyan": "#8b8f98", "brightWhite": "#e7e9ee" }
Set CursorBlink false

# --- off-camera setup: demo.sh clears the screen as its first act, so ---
# --- nothing of the shell needs to show before it takes over. ---
Hide
Type `clear; bash demo/demo.sh`
Enter
Show

Sleep 12900ms
