#!/bin/bash
# ================================================================
# download-libs.sh — Télécharge les librairies JS localement
# Exécutez ce script UNE FOIS avant de déployer l'application.
# Requis : curl
# ================================================================

mkdir -p libs

echo "📥 Téléchargement React..."
curl -L "https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js" -o libs/react.min.js
echo "   ✓ $(wc -c < libs/react.min.js) octets"

echo "📥 Téléchargement ReactDOM..."
curl -L "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js" -o libs/react-dom.min.js
echo "   ✓ $(wc -c < libs/react-dom.min.js) octets"

echo "📥 Téléchargement Babel..."
curl -L "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.2/babel.min.js" -o libs/babel.min.js
echo "   ✓ $(wc -c < libs/babel.min.js) octets"

echo ""
echo "✅ Librairies téléchargées dans le dossier libs/"
echo "   Vous pouvez maintenant déployer l'application."
