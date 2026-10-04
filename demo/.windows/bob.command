#!/bin/zsh
printf '\e]0;bob\a\e[3;960;560t\e[8;30;118t'
exec tmux attach -t demo-bob
