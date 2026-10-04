#!/bin/bash
# Totem LLM — Docker Healthcheck
# Verifies both the Totem server and Ollama are responding.

# Check Totem server
totem_status=$(curl --write-out '%{http_code}' --silent --output /dev/null --max-time 5 http://localhost:8686/api/ping 2>/dev/null)
if [ "$totem_status" != "200" ]; then
    echo "Totem server is down (HTTP $totem_status)"
    exit 1
fi

# Check Ollama (optional — Ollama may not be running in all configurations)
ollama_status=$(curl --write-out '%{http_code}' --silent --output /dev/null --max-time 5 http://localhost:11434/api/version 2>/dev/null)
if [ "$ollama_status" != "200" ]; then
    echo "Warning: Ollama is not responding (HTTP $ollama_status)"
    # Don't fail the healthcheck if Ollama is down — Totem may be using a different provider
fi

echo "All services healthy"
exit 0
