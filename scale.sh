# screen -X -S "scale" stuff $'\003' - Need to find a way to kill a running scren session

# Environment variables
export TTY='/dev/ttyUSB0'
export BAUDRATE=9600
export METER_POLL_MS=250

export MQTT_EDGE_NODE_ID="TEST002"
export MQTT_DEVICE_ID="WT9999X"
export MQTT_HOST_IP="mqtt://10.0.33.126/"
export MQTT_HOST_USERNAME="admin"
export MQTT_HOST_PASSWORD="public"
export MQTT_TOPIC_ROOT="Instruments/Kinsale"

export SPARKPLUG_GROUP_ID="Kinsale"

# Launch in a screen session
cd ~/git/mq_MettlerToledo_MT_SICS/mt-sics
screen -d -m -S scale npm start