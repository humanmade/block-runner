#!/usr/bin/env bash
set -u

O=$'\e[38;2;217;119;87m'
W=$'\e[38;2;231;233;238m'
D=$'\e[38;2;139;143;152m'
G=$'\e[38;2;95;211;141m'
R=$'\e[0m'

trap 'printf "\e[?25h"' EXIT

DELAYS=(0.035 0.055)

typeline() {
  local prompt="$1" orange="$2" white="$3" i delay char
  printf "%s%s%s" "$O" "$prompt" "$R"
  i=0
  while IFS= read -r char; do
    delay="${DELAYS[$((i % 2))]}"
    printf "%s%s%s▍%s" "$O" "$char" "$R" "$O"
    printf "%s" "$R"
    sleep "$delay"
    printf '\b \b'
    i=$((i + 1))
  done < <(printf '%s' "$orange" | grep -o .)
  while IFS= read -r char; do
    delay="${DELAYS[$((i % 2))]}"
    printf "%s%s%s▍%s" "$W" "$char" "$R" "$O"
    printf "%s" "$R"
    sleep "$delay"
    printf '\b \b'
    i=$((i + 1))
  done < <(printf '%s' "$white" | grep -o .)
  printf "%s▍%s" "$O" "$R"
  sleep 0.35
  printf '\b \b\n'
}

printf '\e[?25l\e[2J\e[H'

typeline "❯ " "/block-runner" " Make this card a reusable block. Editors edit the heading, text and image."
printf '\n'
printf "${W}● Plan: acme/feature-card, three editable fields, layout locked.${R}\n"
printf "${W}  Previewing before anything is written.${R}\n"
printf '\n'
sleep 0.5
printf "${O}Bash${R}${D}(npx block-runner author preview feature-card.plan.json)${R}  ${O}✓${R}\n"
printf "${D}  6 files · fields: heading, text, image · warnings: none · nothing written${R}\n"
printf '\n'
sleep 0.6
printf "${W}● Six files, no warnings, nothing written yet. Go ahead?${R}\n"
sleep 0.9
typeline "" "›" " Yes."
printf '\n'
sleep 0.5
printf "${O}Bash${R}${D}(npx block-runner author write feature-card.plan.json --confirm a91f…c3)${R}  ${O}✓${R}\n"
printf '\n'
sleep 0.6
printf "${W}● Written and registered. Feature Card is in the inserter under Acme,${R}\n"
printf "${W}  with only those three fields editable.${R}\n"
printf '\n'
printf "${G}✓ block registered · editor-valid · 0 warnings${R}\n"
printf '\n'
sleep 4
