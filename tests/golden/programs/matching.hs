module Main where

data Color = Red | Green | Blue deriving Show

both :: Bool -> Bool -> String
both True True = "both"
both _ _ = "not both"

classify :: Int -> [Int] -> String
classify 0 [] = "zero, empty"
classify n (x:_)
  | n == x = "head equals n"
classify _ [_, _] = "two elements"
classify n _ = "other " ++ show n

command :: String -> String
command "quit" = "bye"
command "help" = "usage"
command ('#':rest) = "comment: " ++ rest
command s = "unknown " ++ s

next :: Color -> Color
next Red = Green
next Green = Blue
next Blue = Red

zipPairs :: [a] -> [b] -> [(a, b)]
zipPairs (a:as) (b:bs) = (a, b) : zipPairs as bs
zipPairs _ _ = []

firstTwo :: [a] -> Maybe (a, a)
firstTwo xs@(x:y:_) = Just (x, y)
firstTwo _ = Nothing

main :: IO ()
main = do
  print (map (\(a, b) -> both a b) [(True, True), (True, False), (False, True)])
  print (classify 0 [], classify 1 [1, 9], classify 1 [2, 3], classify 5 [], classify 0 [7])
  print (map command ["quit", "help", "#note", "hello", ""])
  print (map next [Red, Green, Blue])
  print (zipPairs [1, 2, 3] "ab")
  print (firstTwo "xyz", firstTwo [1 :: Int])
