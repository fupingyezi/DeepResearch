import ChatWindow from "@/components/chat-window/chat-window";

export default function Home() {
  return (
    <div className="flex h-screen w-full">
      <div className="w-[15%] h-screen"></div>
      <div className="w-[70%] h-screen">
        <ChatWindow
          emptyStateComponent={"Hi, Yezi!😃"}
          placeholder="只要不失去你的崇高，整个世界都会向你敞开。"
        />
      </div>
      <div className="flex-1 h-screen"></div>
    </div>
  );
}
