# Block Runner README demo — rendered with VHS (https://github.com/charmbracelet/vhs)
#   brew install vhs   &&   vhs demo/demo.tape   # writes demo/demo.gif
#
# The visible result is a curated, legible view (demo/demo.sh) — a stylized
# summary of what `block-runner convert hero.html` produces, NOT the raw compact
# serializer markup (which is a dense wall). Revealed line-by-line for a soft scroll.

# Emits demo.gif (README, autoplays on GitHub) + demo.mp4 (Slack/socials, plays reliably).
# For max GIF compatibility (Slack transcodes GIFs and can show a static frame), the
# shipped demo.gif is re-encoded from the mp4 with a clean ffmpeg palette:
#   ffmpeg -i demo/demo.mp4 -vf "fps=15,scale=960:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/pal.png
#   ffmpeg -i demo/demo.mp4 -i /tmp/pal.png -lavfi "fps=15,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a" /tmp/clean.gif
#   gifsicle -O3 --careful /tmp/clean.gif -o demo/demo.gif
Output demo/demo.gif
Output demo/demo.mp4

Set Shell bash
Set FontSize 22
Set Width 1100
Set Height 600
Set Padding 24
Set Margin 28
Set MarginFill "#07080d"
Set BorderRadius 12
Set WindowBar Colorful
# Custom theme matched to the README screenshot: deep-navy canvas, violet
# prompt/command (foreground), soft-white content, muted-grey logs, soft green.
Set Theme { "background": "#0e1018", "foreground": "#a78bfa", "cursor": "#a78bfa", "selection": "#2a2f44", "black": "#0e1018", "red": "#e06c75", "green": "#5fd38d", "yellow": "#d6b27c", "blue": "#7aa2f7", "magenta": "#a78bfa", "cyan": "#56b6c2", "white": "#c6cdd5", "brightBlack": "#646b7a", "brightRed": "#e06c75", "brightGreen": "#5fd38d", "brightYellow": "#d6b27c", "brightBlue": "#7aa2f7", "brightMagenta": "#a78bfa", "brightCyan": "#56b6c2", "brightWhite": "#e6ebf2" }
Set TypingSpeed 45ms
Set CursorBlink true

# --- off-camera setup: clean prompt + a soft line-streamer + the curated view ---
Hide
Type `export PS1='❯ '`
Enter
Type `roll(){ while IFS= read -r l; do printf '%s\n' "$l"; sleep 0.06; done; }`
Enter
Type `block-runner(){ roll < <(bash demo/demo.sh); }`
Enter
Ctrl+L
Sleep 400ms
Show

# --- one clean command → the block tree, revealed softly ---
Type `block-runner convert hero.html`
Enter
Sleep 300ms
Sleep 6500ms
