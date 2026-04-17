$key    = "$HOME\.ssh\hliq_key"
$server = "root@159.69.193.250"

scp -i $key -r "C:/Users/jeank/OneDrive/Desktop/hliq/src"         "${server}:/root/hliq/"
scp -i $key -r "C:/Users/jeank/OneDrive/Desktop/hliq/public"      "${server}:/root/hliq/"
scp -i $key    "C:/Users/jeank/OneDrive/Desktop/hliq/index.html"   "${server}:/root/hliq/"
scp -i $key    "C:/Users/jeank/OneDrive/Desktop/hliq/vite.config.js" "${server}:/root/hliq/"
ssh -i $key $server "pm2 restart hliq"
