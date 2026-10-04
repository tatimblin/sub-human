#!/bin/zsh
printf '\e]0;alice\a\e[3;0;560t\e[8;30;118t'
exec tmux attach -t demo-alice
