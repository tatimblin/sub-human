#!/bin/zsh
printf '\e]0;facilitator\a\e[3;0;30t\e[8;30;118t'
exec tmux attach -t demo-facilitator
